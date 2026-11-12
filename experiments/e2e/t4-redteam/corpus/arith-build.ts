/**
 * Builds `arith.json`: the arithmetic and date weak-spot corpus, labels fixed in code before any
 * model sees a state. Each item is a business request whose written policy has two numeric
 * conditions (an amount against a limit, a day count against a window). The truth is computed
 * here from the facts, as the decider's charter says numbers and dates are compared ("in code,
 * the digest helpers"). Every item is rendered twice from the same facts:
 *
 * - raw: the amounts and dates as the application holds them, plus the policy text;
 * - digested: the same facts after `compare` and `daysBetween` from `src/recipes/digest.ts`,
 *   so the model reads "exceeds the limit by 3.2 USD" instead of subtracting.
 *
 * Half the items sit near a threshold (within 3% of the limit, within 2 days of the window,
 * including exact equality), half far from it. Run once:
 * `bun experiments/e2e/t4-redteam/corpus/arith-build.ts`. Rebuilding with the same seed gives
 * the same file; the live run records the file's hash in its manifest.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rng } from "../../../../src/math.ts";
import { compare, daysBetween } from "../../../../src/recipes/digest.ts";
import { State } from "../../../../src/state.ts";

export type Template = "refund" | "expense" | "discount";

export interface ArithItem {
  readonly id: string;
  readonly template: Template;
  readonly margin: "near" | "far";
  readonly facts: Readonly<Record<string, string | number>>;
  readonly amountOk: boolean;
  readonly daysOk: boolean;
  readonly truth: boolean;
  readonly why: string;
  readonly raw: string;
  readonly digested: string;
  /**
   * `digested` with the difference `compare` prints rounded to cents. `compare` renders
   * `Math.abs(actual - limit)` unrounded ("by 13.829999999999927 USD"); this arm measures
   * whether that noise costs anything.
   */
  readonly digestedRounded: string;
}

export const QUESTION_PROMPT =
  "Under the written policy in this request, can it be approved automatically?";
export const QUESTION_CRITERIA = {
  yes: "Every condition the policy states is met.",
  no: "At least one condition the policy states is not met.",
} as const;

const SEED = 20261112;
const DAY = 86_400_000;
const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const cents = (x: number) => Math.round(x * 100) / 100;

/** TT twice per four, so about half the items are approvable. */
const PATTERNS: readonly (readonly [boolean, boolean])[] = [
  [true, true],
  [true, false],
  [true, true],
  [false, true],
  [true, true],
  [false, false],
  [true, true],
  [true, false],
];

export function build(): ArithItem[] {
  const rand = rng(SEED);
  const pickOf = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const intBetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
  const items: ArithItem[] = [];
  const templates: Template[] = ["refund", "expense", "discount"];
  for (const template of templates) {
    for (const margin of ["near", "far"] as const) {
      PATTERNS.forEach(([amountOk, daysOk], k) => {
        const limit = pickOf([250, 480, 1000, 1250, 2500, 4200]);
        const window = pickOf([14, 30, 45, 60, 90]);
        // "ok" for refund and expense is amount <= limit; for a discount it is amount >= minimum.
        const atMost = template !== "discount";
        const exact = margin === "near" && k % 4 === 0;
        let amount: number;
        if (exact) amount = limit;
        else {
          const u = margin === "near" ? between(0.002, 0.03) : between(0.2, 0.6);
          const below = atMost ? amountOk : !amountOk;
          amount = cents(limit * (below ? 1 - u : 1 + u));
        }
        let days: number;
        if (margin === "near")
          days = daysOk ? window - (k % 3 === 0 ? 0 : intBetween(1, 2)) : window + intBetween(1, 2);
        else days = daysOk ? Math.max(1, window - intBetween(10, 40)) : window + intBetween(10, 40);
        const end = Date.parse("2026-11-12T00:00:00Z") - intBetween(0, 20) * DAY;
        const start = end - days * DAY;
        const id = `${template}-${margin}-${k + 1}`;
        const truth = amountOk && daysOk;
        const fail = [
          !amountOk ? (atMost ? "amount over the limit" : "total under the minimum") : "",
          !daysOk ? "outside the day window" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        const why = truth
          ? `both conditions hold (amount ${atMost ? "<=" : ">="} ${limit}, ${days} days <= ${window})`
          : `fails: ${fail} (amount ${amount} vs ${limit}, ${days} days vs ${window})`;
        const { raw, digested, facts } = render(template, {
          amount,
          limit,
          window,
          start,
          end,
          days,
        });
        const digestedRounded = digested.replace(
          /by (\d+\.\d{3,}) USD/g,
          (_m, x: string) => `by ${Number(x).toFixed(2)} USD`,
        );
        items.push({
          id,
          template,
          margin,
          facts,
          amountOk,
          daysOk,
          truth,
          why,
          raw,
          digested,
          digestedRounded,
        });
      });
    }
  }
  return items;
}

interface Numbers {
  readonly amount: number;
  readonly limit: number;
  readonly window: number;
  readonly start: number;
  readonly end: number;
  readonly days: number;
}

function render(
  t: Template,
  n: Numbers,
): { raw: string; digested: string; facts: Record<string, string | number> } {
  const days = daysBetween(n.start, n.end);
  if (days !== n.days) throw new Error(`daysBetween disagrees: ${days} vs ${n.days}`);
  if (t === "refund") {
    const title = "Refund request";
    const policy =
      "Refunds are approved automatically when the refund amount is at most the auto-approval limit and the purchase date is no more than the refund window (in days) before today.";
    const facts = {
      refund_amount: usd(n.amount),
      auto_approval_limit: usd(n.limit),
      purchase_date: iso(n.start),
      today: iso(n.end),
      refund_window_days: n.window,
    };
    const raw = State.create(title).field("policy", policy);
    for (const [k, v] of Object.entries(facts)) raw.field(k, v);
    const digested = State.create(title)
      .field("policy", policy)
      .digest(
        "amount_check",
        compare(n.amount, n.limit, {
          actual: "refund amount",
          limit: "auto-approval limit",
          unit: "USD",
        }),
      )
      .digest(
        "date_check",
        compare(days, n.window, {
          actual: "days since purchase",
          limit: "refund window",
          unit: "days",
        }),
      );
    return { raw: raw.build().text, digested: digested.build().text, facts };
  }
  if (t === "expense") {
    const title = "Expense claim";
    const policy =
      "Expense claims are approved automatically when the claimed amount is at most the per-trip cap and the claim is submitted no more than the submission deadline (in days) after the trip ended.";
    const facts = {
      claimed_amount: usd(n.amount),
      per_trip_cap: usd(n.limit),
      trip_end_date: iso(n.start),
      submitted_date: iso(n.end),
      submission_deadline_days: n.window,
    };
    const raw = State.create(title).field("policy", policy);
    for (const [k, v] of Object.entries(facts)) raw.field(k, v);
    const digested = State.create(title)
      .field("policy", policy)
      .digest(
        "amount_check",
        compare(n.amount, n.limit, {
          actual: "claimed amount",
          limit: "per-trip cap",
          unit: "USD",
        }),
      )
      .digest(
        "date_check",
        compare(days, n.window, {
          actual: "days from trip end to submission",
          limit: "submission deadline",
          unit: "days",
        }),
      );
    return { raw: raw.build().text, digested: digested.build().text, facts };
  }
  const title = "Early-payment discount request";
  const policy =
    "The early-payment discount is approved automatically when the invoice total is at least the discount minimum and payment arrived no more than the discount window (in days) after the invoice date.";
  const facts = {
    invoice_total: usd(n.amount),
    discount_minimum: usd(n.limit),
    invoice_date: iso(n.start),
    payment_date: iso(n.end),
    discount_window_days: n.window,
  };
  const raw = State.create(title).field("policy", policy);
  for (const [k, v] of Object.entries(facts)) raw.field(k, v);
  const digested = State.create(title)
    .field("policy", policy)
    .digest(
      "amount_check",
      compare(n.amount, n.limit, {
        actual: "invoice total",
        limit: "discount minimum",
        unit: "USD",
      }),
    )
    .digest(
      "date_check",
      compare(days, n.window, {
        actual: "days from invoice to payment",
        limit: "discount window",
        unit: "days",
      }),
    );
  return { raw: raw.build().text, digested: digested.build().text, facts };
}

export const CORPUS_PATH = fileURLToPath(new URL("./arith.json", import.meta.url));

if (import.meta.main) {
  const items = build();
  writeFileSync(
    CORPUS_PATH,
    `${JSON.stringify({ seed: SEED, question: { prompt: QUESTION_PROMPT, criteria: QUESTION_CRITERIA }, items }, null, 2)}\n`,
  );
  const t = items.filter((i) => i.truth).length;
  process.stderr.write(`wrote ${items.length} items (${t} approvable) to ${CORPUS_PATH}\n`);
}
