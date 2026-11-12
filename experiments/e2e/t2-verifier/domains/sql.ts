/**
 * Question to SQL. The application holds the schema and the question; the proposer writes the
 * query; the verifier checks that it answers the question, on the right columns and boundaries,
 * with the requested output shape, using only columns the schema has.
 */
import type { Rand } from "../../../../src/math.ts";
import { addDays, COUNTRIES, day, int, iso, MONTHS, pickOne } from "../pools.ts";
import type { Candidate, ErrorType, Family, Instance, Variant } from "../types.ts";

interface Query {
  readonly select: readonly string[];
  readonly from: string;
  readonly joins: readonly string[];
  readonly where: readonly string[];
  readonly groupBy?: string;
  readonly orderBy?: string;
  readonly limit?: number;
}

function sql(q: Query, lower = false): string {
  const k = (w: string): string => (lower ? w.toLowerCase() : w);
  const lines = [
    `${k("SELECT")} ${q.select.join(", ")}`,
    `${k("FROM")} ${q.from}`,
    ...q.joins.map((j) => (lower ? j.replace(/^JOIN/, "join").replace(" ON ", " on ") : j)),
  ];
  q.where.forEach((w, i) => {
    lines.push(i === 0 ? `${k("WHERE")} ${w}` : `  ${k("AND")} ${w}`);
  });
  if (q.groupBy) lines.push(`${k("GROUP BY")} ${q.groupBy}`);
  if (q.orderBy)
    lines.push(
      `${k("ORDER BY")} ${lower ? q.orderBy.replace(/DESC|ASC/, (m) => m.toLowerCase()) : q.orderBy}`,
    );
  if (q.limit !== undefined) lines.push(`${k("LIMIT")} ${q.limit}`);
  return `${lines.join("\n")};`;
}

const replaceIn = (xs: readonly string[], from: string, to: string): string[] =>
  xs.map((x) => (x === from ? to : x));

/** One question template: the correct query and how each error type mutates it. */
interface Template {
  readonly question: string;
  readonly query: Query;
  /** An equivalent query written differently (the paraphrase). */
  readonly equivalent: Query;
  readonly errors: Partial<Record<ErrorType, { readonly q: Query; readonly why: string }>>;
}

function instanceFrom(schema: string, t: Template): Instance {
  const request = `Write one SQL query (PostgreSQL) against the schema that answers: ${t.question}`;
  const render = (v: Variant, _r: Rand): Candidate => {
    if (v === "plain")
      return { text: sql(t.query), why: "correct: right filters, boundaries, columns and shape" };
    if (v === "benign")
      return { text: sql(t.query, true), why: "correct: keywords in lower case only" };
    if (v === "paraphrase")
      return { text: sql(t.equivalent), why: "correct: an equivalent query written differently" };
    const e = t.errors[v];
    if (!e) throw new Error(`sql template cannot render ${v}`);
    return { text: sql(e.q), why: e.why };
  };
  return {
    task: { request, sources: [{ name: "schema", text: schema }] },
    render,
    supports: Object.keys(t.errors) as ErrorType[],
  };
}

const monthBounds = (
  y: number,
  m: number,
): { lo: string; hi: string; last: string; label: string } => {
  const lo = day(y, m, 1);
  const hi = m === 12 ? day(y + 1, 1, 1) : day(y, m + 1, 1);
  return { lo: iso(lo), hi: iso(hi), last: iso(addDays(hi, -1)), label: `${MONTHS[m - 1]} ${y}` };
};

const SHOP_SCHEMA = [
  "customers(id INTEGER PRIMARY KEY, name TEXT, country TEXT, created_at DATE)",
  "orders(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), placed_at DATE,",
  "       status TEXT -- 'pending', 'shipped' or 'cancelled',",
  "       ship_country TEXT, total_cents INTEGER -- order total in US cents)",
  "order_items(order_id INTEGER REFERENCES orders(id), product_id INTEGER REFERENCES products(id),",
  "            quantity INTEGER, unit_price_cents INTEGER)",
  "products(id INTEGER PRIMARY KEY, name TEXT, category TEXT, price_cents INTEGER)",
].join("\n");

const CATEGORIES = ["Outdoor", "Kitchen", "Garden", "Office", "Toys"] as const;

function shopTemplate(r: Rand): Template {
  const kind = int(r, 0, 2);
  const m = int(r, 1, 12);
  const b = monthBounds(2026, m);
  if (kind === 0) {
    const country = pickOne(r, COUNTRIES);
    const base: Query = {
      select: ["SUM(o.total_cents) / 100.0 AS revenue_usd"],
      from: "orders o",
      joins: ["JOIN customers c ON c.id = o.customer_id"],
      where: [
        `o.status = 'shipped'`,
        `o.placed_at >= '${b.lo}'`,
        `o.placed_at < '${b.hi}'`,
        `c.country = '${country}'`,
      ],
    };
    return {
      question: `What was the total revenue in dollars from shipped orders placed in ${b.label} by customers based in ${country}? Return one column named revenue_usd.`,
      query: base,
      equivalent: {
        ...base,
        select: ["SUM(o.total_cents) / 100.0 AS revenue_usd"],
        where: [
          `c.country = '${country}'`,
          `o.placed_at >= '${b.lo}'`,
          `o.placed_at < '${b.hi}'`,
          `o.status = 'shipped'`,
        ],
      },
      errors: {
        unit_slip: {
          q: { ...base, select: ["SUM(o.total_cents) AS revenue_usd"] },
          why: "sums cents without dividing by 100; the column is labelled dollars",
        },
        date_off_by_one: {
          q: {
            ...base,
            where: replaceIn(base.where, `o.placed_at < '${b.hi}'`, `o.placed_at < '${b.last}'`),
          },
          why: `upper bound < '${b.last}' drops the last day of the month`,
        },
        negation: {
          q: {
            ...base,
            where: replaceIn(base.where, `o.status = 'shipped'`, `o.status <> 'shipped'`),
          },
          why: "status <> 'shipped' selects every order that was not shipped",
        },
        wrong_entity: {
          q: {
            ...base,
            where: replaceIn(
              base.where,
              `c.country = '${country}'`,
              `o.ship_country = '${country}'`,
            ),
          },
          why: "filters on the shipping country, not where the customer is based",
        },
        format_violation: {
          q: { ...base, select: ["SUM(o.total_cents) / 100.0 AS revenue"] },
          why: "column named revenue, not revenue_usd",
        },
        missing_requirement: {
          q: { ...base, where: base.where.filter((w) => !w.startsWith("o.status")) },
          why: "drops the shipped-orders filter",
        },
        unsupported_claim: {
          q: { ...base, where: [...base.where, "c.created_at >= '2025-01-01'"] },
          why: "adds a customer sign-up filter the question never asked for",
        },
        fabricated_citation: {
          q: { ...base, where: base.where.map((w) => w.replace("o.placed_at", "o.shipped_at")) },
          why: "uses o.shipped_at, a column the schema does not have",
        },
      },
    };
  }
  if (kind === 1) {
    const n = pickOne(r, [3, 5, 10]);
    const cat = pickOne(r, CATEGORIES);
    const base: Query = {
      select: ["p.name AS product_name", "SUM(oi.quantity) AS units_sold"],
      from: "order_items oi",
      joins: ["JOIN orders o ON o.id = oi.order_id", "JOIN products p ON p.id = oi.product_id"],
      where: [`p.category = '${cat}'`, `o.placed_at >= '${b.lo}'`, `o.placed_at < '${b.hi}'`],
      groupBy: "p.name",
      orderBy: "units_sold DESC",
      limit: n,
    };
    return {
      question: `List the top ${n} products by units sold in the ${cat} category for orders placed in ${b.label}, with columns product_name and units_sold, highest first.`,
      query: base,
      equivalent: { ...base, orderBy: "SUM(oi.quantity) DESC" },
      errors: {
        wrong_number: {
          q: { ...base, limit: n + 5 },
          why: `LIMIT ${n + 5}; the question asks for the top ${n}`,
        },
        missing_requirement: {
          q: (({ orderBy: _o, ...rest }) => rest)(base),
          why: "no ORDER BY, so LIMIT keeps arbitrary rows, not the top ones",
        },
        negation: {
          q: { ...base, orderBy: "units_sold ASC" },
          why: "orders lowest first; the question wants highest first",
        },
        date_off_by_one: {
          q: {
            ...base,
            where: replaceIn(base.where, `o.placed_at >= '${b.lo}'`, `o.placed_at > '${b.lo}'`),
          },
          why: "> on the first day drops the first day of the month",
        },
        wrong_entity: {
          q: {
            ...base,
            select: ["p.name AS product_name", "SUM(oi.unit_price_cents) AS units_sold"],
          },
          why: "sums unit prices, not quantities",
        },
        format_violation: {
          q: {
            ...base,
            select: ["p.name AS product_name", "SUM(oi.quantity) AS units"],
            orderBy: "units DESC",
          },
          why: "column named units, not units_sold",
        },
        unsupported_claim: {
          q: { ...base, where: [...base.where, "p.price_cents > 1000"] },
          why: "adds a price filter the question never asked for",
        },
        fabricated_citation: {
          q: {
            ...base,
            select: ["p.title AS product_name", "SUM(oi.quantity) AS units_sold"],
            groupBy: "p.title",
          },
          why: "uses p.title, a column the schema does not have",
        },
      },
    };
  }
  const country = pickOne(r, COUNTRIES);
  const y = int(r, 2023, 2025);
  const base: Query = {
    select: ["COUNT(DISTINCT c.id) AS customers"],
    from: "customers c",
    joins: ["JOIN orders o ON o.customer_id = c.id"],
    where: [
      `c.country = '${country}'`,
      `c.created_at >= '${y}-01-01'`,
      `c.created_at < '${y + 1}-01-01'`,
      `o.status = 'cancelled'`,
    ],
  };
  return {
    question: `How many customers based in ${country} signed up in ${y} and have at least one cancelled order? Return one column named customers.`,
    query: base,
    equivalent: {
      select: ["COUNT(*) AS customers"],
      from: "customers c",
      joins: [],
      where: [
        `c.country = '${country}'`,
        `c.created_at >= '${y}-01-01'`,
        `c.created_at < '${y + 1}-01-01'`,
        "EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'cancelled')",
      ],
    },
    errors: {
      wrong_entity: {
        q: { ...base, select: ["COUNT(*) AS customers"] },
        why: "COUNT(*) over the join counts cancelled orders, not customers",
      },
      negation: {
        q: {
          ...base,
          where: replaceIn(base.where, `o.status = 'cancelled'`, `o.status <> 'cancelled'`),
        },
        why: "status <> 'cancelled' finds customers with any other order",
      },
      date_off_by_one: {
        q: {
          ...base,
          where: replaceIn(
            base.where,
            `c.created_at < '${y + 1}-01-01'`,
            `c.created_at < '${y}-12-31'`,
          ),
        },
        why: "upper bound drops sign-ups on 31 December",
      },
      format_violation: {
        q: { ...base, select: ["COUNT(DISTINCT c.id) AS n"] },
        why: "column named n, not customers",
      },
      missing_requirement: {
        q: { ...base, where: base.where.filter((w) => !w.startsWith("c.country")) },
        why: "drops the country filter",
      },
      unsupported_claim: {
        q: { ...base, where: [...base.where, `o.placed_at >= '${y + 1}-01-01'`] },
        why: `adds an order-date filter (orders from ${y + 1} on) the question never asked for`,
      },
      fabricated_citation: {
        q: { ...base, where: base.where.map((w) => w.replace("c.created_at", "c.signup_date")) },
        why: "uses c.signup_date, a column the schema does not have",
      },
    },
  };
}

function templateFamily(
  id: string,
  split: "fit" | "heldout" | "challenge",
  schema: string,
  make: (r: Rand) => Template,
): Family {
  return {
    id,
    domain: "sql",
    split,
    // Errors vary by question template; the corpus asks each instance which it supports.
    errors: [
      "wrong_number",
      "missing_requirement",
      "unsupported_claim",
      "wrong_entity",
      "date_off_by_one",
      "unit_slip",
      "format_violation",
      "fabricated_citation",
      "negation",
    ],
    make: (r) => instanceFrom(schema, make(r)),
  };
}

const HR_SCHEMA = [
  "departments(id INTEGER PRIMARY KEY, name TEXT, location TEXT)",
  "employees(id INTEGER PRIMARY KEY, full_name TEXT, department_id INTEGER REFERENCES departments(id),",
  "          manager_id INTEGER REFERENCES employees(id), hired_on DATE,",
  "          salary_annual INTEGER -- US dollars per year, status TEXT -- 'active' or 'terminated')",
].join("\n");

const DEPTS = ["Finance", "Engineering", "Support", "Marketing", "Legal"] as const;
const LOCATIONS = ["Lisbon", "Toronto", "Singapore", "Dublin", "Austin"] as const;

function hrTemplate(r: Rand): Template {
  const kind = int(r, 0, 2);
  if (kind === 0) {
    const dept = pickOne(r, DEPTS);
    const cut = day(int(r, 2021, 2025), int(r, 1, 12), 1);
    const base: Query = {
      select: ["AVG(e.salary_annual) AS avg_salary"],
      from: "employees e",
      joins: ["JOIN departments d ON d.id = e.department_id"],
      where: [`d.name = '${dept}'`, "e.status = 'active'", `e.hired_on < '${iso(cut)}'`],
    };
    return {
      question: `What is the average annual salary of active employees in the ${dept} department who were hired before ${iso(cut)}? Return one column named avg_salary.`,
      query: base,
      equivalent: {
        ...base,
        where: [`e.hired_on < '${iso(cut)}'`, "e.status = 'active'", `d.name = '${dept}'`],
      },
      errors: {
        unit_slip: {
          q: { ...base, select: ["AVG(e.salary_annual / 12) AS avg_salary"] },
          why: "averages monthly salary; the question asks for annual",
        },
        negation: {
          q: {
            ...base,
            where: replaceIn(base.where, "e.status = 'active'", "e.status <> 'active'"),
          },
          why: "status <> 'active' selects terminated employees",
        },
        date_off_by_one: {
          q: {
            ...base,
            where: replaceIn(
              base.where,
              `e.hired_on < '${iso(cut)}'`,
              `e.hired_on <= '${iso(cut)}'`,
            ),
          },
          why: `<= includes hires on ${iso(cut)}, which is not before it`,
        },
        wrong_entity: {
          q: {
            ...base,
            where: replaceIn(base.where, `d.name = '${dept}'`, `d.location = '${dept}'`),
          },
          why: "filters the department name against the location column",
        },
        format_violation: {
          q: { ...base, select: ["AVG(e.salary_annual) AS average"] },
          why: "column named average, not avg_salary",
        },
        missing_requirement: {
          q: { ...base, where: base.where.filter((w) => !w.startsWith("e.status")) },
          why: "drops the active-employees filter",
        },
        unsupported_claim: {
          q: { ...base, where: [...base.where, "e.manager_id IS NOT NULL"] },
          why: "adds a has-a-manager filter the question never asked for",
        },
        fabricated_citation: {
          q: { ...base, select: ["AVG(e.salary) AS avg_salary"] },
          why: "uses e.salary, a column the schema does not have",
        },
      },
    };
  }
  if (kind === 1) {
    const n = pickOne(r, [3, 5, 10]);
    const loc = pickOne(r, LOCATIONS);
    const base: Query = {
      select: ["e.full_name"],
      from: "employees e",
      joins: ["JOIN departments d ON d.id = e.department_id"],
      where: [`d.location = '${loc}'`],
      orderBy: "e.hired_on DESC",
      limit: n,
    };
    return {
      question: `Who are the ${n} most recently hired employees in departments located in ${loc}? Return the column full_name, newest first.`,
      query: base,
      equivalent: { ...base, select: ["e.full_name AS full_name"] },
      errors: {
        wrong_number: {
          q: { ...base, limit: n * 2 },
          why: `LIMIT ${n * 2}; the question asks for ${n}`,
        },
        negation: {
          q: { ...base, orderBy: "e.hired_on ASC" },
          why: "orders oldest first; the question wants newest first",
        },
        missing_requirement: { q: { ...base, where: [] }, why: "drops the location filter" },
        wrong_entity: {
          q: { ...base, where: [`d.name = '${loc}'`] },
          why: "matches the location against the department name",
        },
        format_violation: {
          q: { ...base, select: ["e.full_name AS name"] },
          why: "column named name, not full_name",
        },
        unsupported_claim: {
          q: { ...base, where: [...base.where, "e.salary_annual > 50000"] },
          why: "adds a salary filter the question never asked for",
        },
        fabricated_citation: {
          q: { ...base, orderBy: "e.start_date DESC" },
          why: "orders by e.start_date, a column the schema does not have",
        },
      },
    };
  }
  const mgr = int(r, 100, 999);
  const pay = int(r, 6, 18) * 10000;
  const base: Query = {
    select: ["COUNT(*) AS headcount"],
    from: "employees e",
    joins: [],
    where: [`e.manager_id = ${mgr}`, `e.salary_annual > ${pay}`],
  };
  return {
    question: `How many employees report directly to manager ${mgr} and earn more than $${pay} a year? Return one column named headcount.`,
    query: base,
    equivalent: { ...base, select: ["COUNT(e.id) AS headcount"] },
    errors: {
      wrong_number: {
        q: {
          ...base,
          where: replaceIn(base.where, `e.salary_annual > ${pay}`, `e.salary_annual > ${pay / 10}`),
        },
        why: `threshold ${pay / 10}; the question says ${pay}`,
      },
      unit_slip: {
        q: {
          ...base,
          where: replaceIn(base.where, `e.salary_annual > ${pay}`, `e.salary_annual / 12 > ${pay}`),
        },
        why: "compares monthly salary with an annual threshold",
      },
      negation: {
        q: {
          ...base,
          where: replaceIn(base.where, `e.salary_annual > ${pay}`, `e.salary_annual <= ${pay}`),
        },
        why: "<= selects employees earning at most the threshold",
      },
      wrong_entity: {
        q: { ...base, where: replaceIn(base.where, `e.manager_id = ${mgr}`, `e.id = ${mgr}`) },
        why: "filters on the employee id instead of manager_id",
      },
      missing_requirement: {
        q: { ...base, where: [`e.manager_id = ${mgr}`] },
        why: "drops the salary condition",
      },
      format_violation: {
        q: { ...base, select: ["COUNT(*) AS total"] },
        why: "column named total, not headcount",
      },
      unsupported_claim: {
        q: { ...base, where: [...base.where, "e.hired_on >= '2020-01-01'"] },
        why: "adds a hire-date filter the question never asked for",
      },
      fabricated_citation: {
        q: {
          ...base,
          where: replaceIn(base.where, `e.manager_id = ${mgr}`, `e.reports_to = ${mgr}`),
        },
        why: "uses e.reports_to, a column the schema does not have",
      },
    },
  };
}

const EVENTS_SCHEMA = [
  "users(id INTEGER PRIMARY KEY, plan TEXT -- 'free', 'pro' or 'team',",
  "      signup_at TIMESTAMP -- UTC, country TEXT)",
  "events(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), event_type TEXT,",
  "       occurred_at TIMESTAMP -- UTC)",
].join("\n");

function eventsTemplate(r: Rand): Template {
  const kind = int(r, 0, 1);
  const plan = pickOne(r, ["pro", "team"] as const);
  if (kind === 0) {
    const d = day(2026, int(r, 1, 12), int(r, 2, 26));
    const lo = `${iso(d)} 00:00:00`;
    const hi = `${iso(addDays(d, 1))} 00:00:00`;
    const base: Query = {
      select: ["COUNT(DISTINCT e.user_id) AS active_users"],
      from: "events e",
      joins: ["JOIN users u ON u.id = e.user_id"],
      where: [`u.plan = '${plan}'`, `e.occurred_at >= '${lo}'`, `e.occurred_at < '${hi}'`],
    };
    return {
      question: `How many distinct ${plan}-plan users had at least one event of any type on ${iso(d)} (UTC)? Return one column named active_users.`,
      query: base,
      equivalent: {
        ...base,
        where: [`e.occurred_at >= '${lo}'`, `e.occurred_at < '${hi}'`, `u.plan = '${plan}'`],
      },
      errors: {
        missing_requirement: {
          q: { ...base, select: ["COUNT(e.user_id) AS active_users"] },
          why: "counts events, not distinct users",
        },
        date_off_by_one: {
          q: {
            ...base,
            where: replaceIn(
              replaceIn(
                base.where,
                `e.occurred_at >= '${lo}'`,
                `e.occurred_at >= '${iso(addDays(d, -1))} 00:00:00'`,
              ),
              `e.occurred_at < '${hi}'`,
              `e.occurred_at < '${lo}'`,
            ),
          },
          why: "window is the previous day",
        },
        wrong_entity: {
          q: { ...base, where: base.where.map((w) => w.replace("e.occurred_at", "u.signup_at")) },
          why: "filters on sign-up time, not event time",
        },
        negation: {
          q: { ...base, where: replaceIn(base.where, `u.plan = '${plan}'`, `u.plan <> '${plan}'`) },
          why: `plan <> '${plan}' counts every other plan`,
        },
        format_violation: {
          q: { ...base, select: ["COUNT(DISTINCT e.user_id) AS dau"] },
          why: "column named dau, not active_users",
        },
        unsupported_claim: {
          q: { ...base, where: [...base.where, "e.event_type = 'login'"] },
          why: "counts only login events; the question says any event",
        },
        fabricated_citation: {
          q: { ...base, where: base.where.map((w) => w.replace("e.occurred_at", "e.created_at")) },
          why: "uses e.created_at, a column the schema does not have",
        },
      },
    };
  }
  const m = int(r, 1, 12);
  const b = monthBounds(2026, m);
  const country = pickOne(r, COUNTRIES);
  const base: Query = {
    select: ["COUNT(*) AS signups"],
    from: "users u",
    joins: [],
    where: [
      `u.plan = '${plan}'`,
      `u.country = '${country}'`,
      `u.signup_at >= '${b.lo} 00:00:00'`,
      `u.signup_at < '${b.hi} 00:00:00'`,
    ],
  };
  return {
    question: `How many ${plan}-plan users in ${country} signed up during ${b.label} (UTC)? Return one column named signups.`,
    query: base,
    equivalent: { ...base, select: ["COUNT(u.id) AS signups"] },
    errors: {
      date_off_by_one: {
        q: {
          ...base,
          where: replaceIn(
            base.where,
            `u.signup_at < '${b.hi} 00:00:00'`,
            `u.signup_at < '${b.last} 00:00:00'`,
          ),
        },
        why: "upper bound drops sign-ups on the last day of the month",
      },
      negation: {
        q: { ...base, where: replaceIn(base.where, `u.plan = '${plan}'`, `u.plan <> '${plan}'`) },
        why: `plan <> '${plan}' counts every other plan`,
      },
      wrong_entity: { q: { ...base, from: "events u" }, why: "counts rows of events, not users" },
      missing_requirement: {
        q: { ...base, where: base.where.filter((w) => !w.startsWith("u.country")) },
        why: "drops the country filter",
      },
      format_violation: {
        q: { ...base, select: ["COUNT(*) AS total_signups"] },
        why: "column named total_signups, not signups",
      },
      unsupported_claim: {
        q: { ...base, where: [...base.where, "u.id IN (SELECT user_id FROM events)"] },
        why: "keeps only users with events, which the question never asked for",
      },
      fabricated_citation: {
        q: {
          ...base,
          where: replaceIn(base.where, `u.country = '${country}'`, `u.region = '${country}'`),
        },
        why: "uses u.region, a column the schema does not have",
      },
      wrong_number: {
        q: {
          ...base,
          where: replaceIn(
            replaceIn(
              base.where,
              `u.signup_at >= '${b.lo} 00:00:00'`,
              `u.signup_at >= '${b.lo.replace("2026", "2025")} 00:00:00'`,
            ),
            `u.signup_at < '${b.hi} 00:00:00'`,
            `u.signup_at < '${b.hi.replace("2026", "2025").replace("2027", "2026")} 00:00:00'`,
          ),
        },
        why: "the window is the same month a year earlier",
      },
    },
  };
}

export const sqlFamilies: readonly Family[] = [
  templateFamily("sql.shop", "fit", SHOP_SCHEMA, shopTemplate),
  templateFamily("sql.hr", "heldout", HR_SCHEMA, hrTemplate),
  templateFamily("sql.events", "challenge", EVENTS_SCHEMA, eventsTemplate),
];
