import { canonical, makeTask, splitFor } from "./corpus.ts";
import type { Check, Json, Task } from "./types.ts";

interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

async function database(): Promise<Database> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    return new Database(":memory:");
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(":memory:");
}

const literal = (value: Json): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;
type Tables = Record<string, Json[][]>;
interface SqlFamily {
  readonly name: string;
  readonly schema: string;
  readonly requirement: (v: number) => string;
  readonly programs: (v: number) => readonly string[];
  readonly visible: (v: number) => readonly Tables[];
  readonly hidden: (v: number) => readonly Tables[];
  readonly expected: (tables: Tables, v: number) => Json;
}

const SQL: readonly SqlFamily[] = [
  {
    name: "paid-total",
    schema: "CREATE TABLE sales(customer TEXT, amount INTEGER, status TEXT);",
    requirement: () =>
      "Return customer,total for each customer with paid sales, summing only amount of rows whose status is 'paid'. Order by customer ascending. Amounts are non-null integers.",
    programs: () => [
      "SELECT customer, SUM(amount) AS total FROM sales WHERE status='paid' GROUP BY customer ORDER BY customer",
      "SELECT customer, SUM(amount) AS total FROM sales GROUP BY customer ORDER BY customer",
      "SELECT customer, SUM(DISTINCT amount) AS total FROM sales WHERE status='paid' GROUP BY customer ORDER BY customer",
      "SELECT customer, MAX(amount) AS total FROM sales WHERE status='paid' GROUP BY customer ORDER BY customer",
    ],
    visible: (v) => [
      {
        sales: [
          ["a", v + 2, "paid"],
          ["b", v + 3, "paid"],
        ],
      },
    ],
    hidden: (v) => [
      { sales: [] },
      {
        sales: [
          ["a", v + 2, "paid"],
          ["a", v + 2, "paid"],
          ["a", 99, "cancelled"],
          ["b", 4, "cancelled"],
        ],
      },
      {
        sales: [
          ["b", -2, "paid"],
          ["b", 0, "paid"],
          ["a", 3, "paid"],
        ],
      },
    ],
    expected: ({ sales = [] }) => {
      const totals = new Map<string, number>();
      for (const [customer, amount, status] of sales)
        if (status === "paid")
          totals.set(String(customer), (totals.get(String(customer)) ?? 0) + Number(amount));
      return [...totals.keys()]
        .sort()
        .map((customer) => ({ customer, total: totals.get(customer) ?? 0 }));
    },
  },
  {
    name: "left-join-count",
    schema:
      "CREATE TABLE customers(id INTEGER PRIMARY KEY); CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER);",
    requirement: () =>
      "Return id,n for EVERY customer, with n the number of matching orders (zero when none). Order by customer id. Order ids are non-null; orders.customer may be null.",
    programs: () => [
      "SELECT c.id, COUNT(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer=c.id GROUP BY c.id ORDER BY c.id",
      "SELECT c.id, COUNT(o.id) AS n FROM customers c JOIN orders o ON o.customer=c.id GROUP BY c.id ORDER BY c.id",
      "SELECT c.id, COUNT(*) AS n FROM customers c LEFT JOIN orders o ON o.customer=c.id GROUP BY c.id ORDER BY c.id",
      "SELECT c.id, COUNT(DISTINCT o.customer) AS n FROM customers c LEFT JOIN orders o ON o.customer=c.id GROUP BY c.id ORDER BY c.id",
    ],
    visible: () => [
      {
        customers: [[1], [2]],
        orders: [
          [1, 1],
          [2, 2],
        ],
      },
    ],
    hidden: (v) => [
      { customers: [], orders: [] },
      {
        customers: [[1], [2], [3]],
        orders: [
          [1, 1],
          [2, 1],
          [3, null],
          [4, 2],
        ],
      },
      { customers: [[v + 5]], orders: [] },
    ],
    expected: ({ customers = [], orders = [] }) =>
      customers
        .map(([id]) => ({ id: id ?? null, n: orders.filter((row) => row[1] === id).length }))
        .sort((a, b) => Number(a.id) - Number(b.id)),
  },
  {
    name: "null-antijoin",
    schema:
      "CREATE TABLE customers(id INTEGER PRIMARY KEY); CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER);",
    requirement: () =>
      "Return id for customers with NO matching order. orders.customer may be null and must not prevent unrelated customers from being returned. Order by id.",
    programs: () => [
      "SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer=c.id) ORDER BY c.id",
      "SELECT id FROM customers WHERE id NOT IN (SELECT customer FROM orders) ORDER BY id",
      "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer=c.id) ORDER BY c.id",
      "SELECT id FROM customers ORDER BY id",
    ],
    visible: () => [{ customers: [[1], [2]], orders: [[1, 1]] }],
    hidden: (v) => [
      {
        customers: [[1], [2], [v + 3]],
        orders: [
          [1, 1],
          [2, null],
        ],
      },
      { customers: [[1], [2]], orders: [] },
      { customers: [], orders: [[1, null]] },
    ],
    expected: ({ customers = [], orders = [] }) =>
      customers
        .filter(([id]) => !orders.some((row) => row[1] === id))
        .map(([id]) => ({ id: id ?? null }))
        .sort((a, b) => Number(a.id) - Number(b.id)),
  },
  {
    name: "latest-version",
    schema: "CREATE TABLE records(k TEXT, version INTEGER, value INTEGER, UNIQUE(k, version));",
    requirement: () =>
      "Return k,value from the row with greatest version for each k, ordered by k. Each (k,version) is unique. All fields are non-null.",
    programs: () => [
      "SELECT r.k, r.value FROM records r WHERE r.version=(SELECT MAX(s.version) FROM records s WHERE s.k=r.k) ORDER BY r.k",
      "SELECT k, value FROM records GROUP BY k ORDER BY k",
      "SELECT r.k, r.value FROM records r WHERE r.version=(SELECT MIN(s.version) FROM records s WHERE s.k=r.k) ORDER BY r.k",
      "SELECT k, value FROM records ORDER BY k",
    ],
    visible: (v) => [
      {
        records: [
          ["a", 1, v],
          ["b", 1, v + 1],
        ],
      },
    ],
    hidden: (v) => [
      { records: [] },
      {
        records: [
          ["a", 1, v],
          ["a", 2, v + 1],
          ["b", 2, v + 2],
          ["b", 1, v + 3],
        ],
      },
      {
        records: [
          ["a", 9, v + 10],
          ["a", 0, v + 20],
          ["a", 4, v + 30],
        ],
      },
    ],
    expected: ({ records = [] }) =>
      [...new Set(records.map((row) => String(row[0])))].sort().map((k) => {
        const group = records
          .filter((row) => row[0] === k)
          .sort((a, b) => Number(b[1]) - Number(a[1]));
        return { k, value: group[0]?.[2] ?? null };
      }),
  },
  {
    name: "window-total",
    schema: "CREATE TABLE events(day INTEGER, amount INTEGER);",
    requirement: (v) =>
      `Return a single row total: sum amount for day in [${v + 2},${v + 5}), with the upper endpoint excluded. Return 0 if no row qualifies. Fields are non-null integers.`,
    programs: (v) => [
      `SELECT COALESCE(SUM(amount),0) AS total FROM events WHERE day>=${v + 2} AND day<${v + 5}`,
      `SELECT COALESCE(SUM(amount),0) AS total FROM events WHERE day BETWEEN ${v + 2} AND ${v + 5}`,
      `SELECT COALESCE(SUM(amount),0) AS total FROM events WHERE day>${v + 2} AND day<${v + 5}`,
      `SELECT SUM(amount) AS total FROM events WHERE day>=${v + 2} AND day<${v + 5}`,
    ],
    visible: (v) => [
      {
        events: [
          [v + 3, 10],
          [v + 7, 20],
        ],
      },
    ],
    hidden: (v) => [
      { events: [] },
      {
        events: [
          [v + 2, 2],
          [v + 3, 3],
          [v + 4, 4],
          [v + 5, 5],
          [v + 1, 1],
        ],
      },
      { events: [[v + 8, 10]] },
    ],
    expected: ({ events = [] }, v) => [
      {
        total: events
          .filter(([day]) => [v + 2, v + 3, v + 4].includes(Number(day)))
          .reduce((sum, row) => sum + Number(row[1]), 0),
      },
    ],
  },
  {
    name: "distinct-customers",
    schema: "CREATE TABLE visits(customer TEXT, page TEXT);",
    requirement: () =>
      "Return one row n: the number of distinct non-null customers in visits. Repeated visits by a customer count once. Null customers count zero. Empty input returns 0.",
    programs: () => [
      "SELECT COUNT(DISTINCT customer) AS n FROM visits",
      "SELECT COUNT(customer) AS n FROM visits",
      "SELECT COUNT(*) AS n FROM visits",
      "SELECT COUNT(DISTINCT page) AS n FROM visits",
    ],
    visible: () => [
      {
        visits: [
          ["a", "x"],
          ["b", "y"],
        ],
      },
    ],
    hidden: (v) => [
      { visits: [] },
      {
        visits: [
          ["a", "x"],
          ["a", "y"],
          [null, "z"],
          [`b${v}`, "w"],
        ],
      },
      {
        visits: [
          ["a", "x"],
          ["b", "x"],
        ],
      },
    ],
    expected: ({ visits = [] }) => [
      { n: new Set(visits.filter((row) => row[0] !== null).map((row) => row[0])).size },
    ],
  },
];

/** Execute only the module's authored SELECTs against fresh, local in-memory fixtures. */
export async function buildSqlTasks(variants = 3): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const [index, family] of SQL.entries()) {
    for (let v = 0; v < variants; v++) {
      const visible = family.visible(v);
      const hidden = family.hidden(v);
      const databases: Database[] = [];
      const checks: Check[] = [];
      try {
        for (const tables of [...visible, ...hidden]) {
          const db = await database();
          databases.push(db);
          db.exec(family.schema);
          for (const [table, rows] of Object.entries(tables)) {
            for (const row of rows)
              db.exec(`INSERT INTO ${table} VALUES (${row.map(literal).join(",")})`);
          }
          checks.push({ input: tables, expected: family.expected(tables, v) });
        }
        tasks.push(
          makeTask(
            {
              id: `sql/${family.name}/${v}`,
              family: `sql/${family.name}`,
              domain: "sql",
              split: splitFor(index),
              requirement: `${family.requirement(v)}\nSchema: ${family.schema}`,
              language: "sqlite",
              publicExamples: checks.slice(0, visible.length),
            },
            family.programs(v),
            (source, secret) => {
              try {
                const take = secret ? databases.length : visible.length;
                return databases
                  .slice(0, take)
                  .every(
                    (db, i) =>
                      canonical(db.prepare(source).all()) === canonical(checks[i]?.expected),
                  );
              } catch {
                return false;
              }
            },
            { public: visible.length, hidden: hidden.length },
            v,
          ),
        );
      } finally {
        for (const db of databases) db.close();
      }
    }
  }
  return tasks;
}
