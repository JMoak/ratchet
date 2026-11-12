/**
 * Task 1 corpus: an approvals desk for an imagined outdoor-gear retailer, Larkspur Outfitters.
 * Refund requests and employee expense claims are judged against the written policy carried
 * in the state's trusted fields. The label is the policy applied in code to the facts
 * (`refundVerdict`, `expenseVerdict`): the decider follows the written policy exactly, and
 * marks the few cases where the policy is silent as ambiguous.
 *
 * Each item renders three ways from the same facts, so the arms are paired:
 * - raw: amounts and calendar dates as a system of record would hold them;
 * - digest: the comparisons computed in code with `compare`, `count` and `band`
 *   (`src/recipes/digest.ts`), the arithmetic the live findings say Jev misses;
 * - relative: dates as `relativeTime` phrases and nothing else digested, the literal reading of
 *   "make dates relative", to see what that helper's rounding does near a policy boundary.
 *
 * Floors live in code and are invisible to the model: an amount over the automation limit
 * ($1,000 refund, $2,000 expense) must go to review, and a wire transfer is a one-way door.
 * The label is policy eligibility; the floor is checked separately (no floored item may act).
 */
import { band, compare, count, daysBetween, relativeTime } from "../../../../src/recipes/digest.ts";
import { State } from "../../../../src/state.ts";
import { addDays, Draw, dateBetween, type Label, label, opaqueId, usd } from "./common.ts";

export const REFUND_POLICY = [
  "Refund policy of Larkspur Outfitters. Approve a refund only when every rule below is met:",
  "1. Requested within 30 days of delivery, or within 60 days for VIP members.",
  "2. The item is not marked final sale.",
  "3. The item is unused, unless the customer reports it defective.",
  "4. An order number or receipt is on file.",
  "5. The refund requested is not more than the price paid.",
  "6. Counting this one, the customer has had at most 2 refunds in the 90 days before this request (VIP members: at most 4).",
].join("\n");

export const EXPENSE_POLICY = [
  "Employee expense policy of Larkspur Outfitters. Approve a claim only when every rule below that applies is met:",
  "1. Submitted within 60 days of the expense date.",
  "2. A receipt is attached for any expense of $25.00 or more.",
  "3. Meals: at most $75.00 per attendee (the total divided by the number of attendees), and no alcohol on the receipt.",
  "4. Flights: economy class, except that business class is allowed for a flight scheduled to last longer than 6 hours.",
  "5. Hotels: at most $250.00 per night, or at most $350.00 per night in a city on the company's high-cost list.",
].join("\n");

/** Automation limits enforced by floors in code, never shown to the model. */
export const REFUND_HARD_LIMIT = 1000;
export const EXPENSE_HARD_LIMIT = 2000;

export interface PriorRefund {
  readonly on: string;
  readonly amount: number;
}

export interface RefundFacts {
  readonly kind: "refund";
  /** "VIP-lapsed" is a VIP membership that ended shortly before the request: the policy is silent. */
  readonly tier: "standard" | "VIP" | "VIP-lapsed";
  readonly item: string;
  readonly deliveredOn: string;
  readonly requestedOn: string;
  readonly pricePaid: number;
  readonly amount: number;
  readonly finalSale: boolean;
  readonly condition: "unused" | "used" | "defective" | "opened but unused";
  readonly receipt: boolean;
  readonly priorRefunds: readonly PriorRefund[];
  readonly payout: "original card" | "store credit" | "wire transfer";
  readonly message: string;
}

export interface ExpenseFacts {
  readonly kind: "expense";
  readonly category: "meal" | "flight" | "hotel" | "taxi";
  readonly description: string;
  readonly expenseOn: string;
  readonly submittedOn: string;
  readonly amount: number;
  readonly receipt: boolean;
  readonly attendees?: number;
  readonly alcohol?: boolean;
  readonly cabin?: "economy" | "business" | "business (upgrade at no extra cost)";
  readonly flightMinutes?: number;
  readonly nights?: number;
  readonly city?: string;
  readonly highCost?: boolean;
  readonly reimbursement: "payroll" | "wire transfer to an external account";
}

export type ApprovalFacts = RefundFacts | ExpenseFacts;

export interface ApprovalItem {
  readonly id: string;
  readonly scenario: string;
  readonly facts: ApprovalFacts;
  readonly label: Label;
  /** What the code floors must do with this item: never act. */
  readonly floor: { readonly overLimit: boolean; readonly wire: boolean };
  readonly states: { readonly raw: string; readonly digest: string; readonly relative: string };
}

// ---------------------------------------------------------------------------
// The policy, applied in code. This is the label: the decider follows the written policy.
// ---------------------------------------------------------------------------

const refundWindow = (tier: RefundFacts["tier"]): number => (tier === "VIP" ? 60 : 30);
const refundLimit = (tier: RefundFacts["tier"]): number => (tier === "VIP" ? 4 : 2);

/** Prior refunds inside the 90 days before the request (0 to 90 days before it). */
export const priorsInWindow = (f: RefundFacts): number =>
  f.priorRefunds.filter((p) => {
    const d = daysBetween(`${p.on}T00:00:00Z`, `${f.requestedOn}T00:00:00Z`);
    return d >= 0 && d <= 90;
  }).length;

export function refundVerdict(f: RefundFacts): { ok: boolean; why: string } {
  const days = daysBetween(`${f.deliveredOn}T00:00:00Z`, `${f.requestedOn}T00:00:00Z`);
  const window = refundWindow(f.tier);
  const lapsed =
    f.tier === "VIP-lapsed" ? " (lapsed VIP read as standard, the cautious reading)" : "";
  if (days > window)
    return {
      ok: false,
      why: `rule 1: ${days} days after delivery, past the ${window}-day window${lapsed}`,
    };
  if (f.finalSale) return { ok: false, why: "rule 2: final sale" };
  if (f.condition === "used") return { ok: false, why: "rule 3: used and not reported defective" };
  if (!f.receipt) return { ok: false, why: "rule 4: no order number or receipt on file" };
  if (f.amount > f.pricePaid)
    return {
      ok: false,
      why: `rule 5: requests ${usd(f.amount)}, more than the ${usd(f.pricePaid)} paid`,
    };
  const k = priorsInWindow(f);
  if (k + 1 > refundLimit(f.tier))
    return {
      ok: false,
      why: `rule 6: ${k} refunds in the prior 90 days plus this one exceeds ${refundLimit(f.tier)}`,
    };
  const opened =
    f.condition === "opened but unused" ? "; opened but unused read as unused (customer-fair)" : "";
  return {
    ok: true,
    why: `every rule met: day ${days} of ${window}, ${k} prior refunds in 90 days${opened}`,
  };
}

const perAttendee = (f: ExpenseFacts): number =>
  Math.round((f.amount / (f.attendees ?? 1)) * 100) / 100;
const perNight = (f: ExpenseFacts): number => Math.round((f.amount / (f.nights ?? 1)) * 100) / 100;
const nightlyLimit = (f: ExpenseFacts): number => (f.highCost ? 350 : 250);
const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

export function expenseVerdict(f: ExpenseFacts): { ok: boolean; why: string } {
  const days = daysBetween(`${f.expenseOn}T00:00:00Z`, `${f.submittedOn}T00:00:00Z`);
  if (days > 60) return { ok: false, why: `rule 1: submitted ${days} days after the expense` };
  if (f.amount >= 25 && !f.receipt)
    return { ok: false, why: `rule 2: ${usd(f.amount)} with no receipt` };
  if (f.category === "meal") {
    if (perAttendee(f) > 75)
      return { ok: false, why: `rule 3: ${usd(perAttendee(f))} per attendee, over $75.00` };
    if (f.alcohol) return { ok: false, why: "rule 3: alcohol on the receipt" };
  }
  if (f.category === "flight" && f.cabin !== "economy" && (f.flightMinutes ?? 0) <= 360) {
    const upgrade =
      f.cabin === "business (upgrade at no extra cost)"
        ? "; a free upgrade is still business class (literal reading)"
        : "";
    return {
      ok: false,
      why: `rule 4: business class on a ${f.flightMinutes}-minute flight${upgrade}`,
    };
  }
  if (f.category === "hotel" && perNight(f) > nightlyLimit(f))
    return {
      ok: false,
      why: `rule 5: ${usd(perNight(f))} per night, over ${usd(nightlyLimit(f))}`,
    };
  return {
    ok: true,
    why: `every applicable rule met (${f.category}, submitted after ${days} days)`,
  };
}

// ---------------------------------------------------------------------------
// Rendering: three arms from the same facts.
// ---------------------------------------------------------------------------

const yesNo = (b: boolean): string => (b ? "yes" : "no");
const tierText = (t: RefundFacts["tier"]): string =>
  t === "VIP-lapsed" ? "VIP membership expired 5 days before this request" : t;

const AMOUNT_BANDS = [
  { upTo: 50, label: "under $50" },
  { upTo: 250, label: "$50 to $250" },
  { upTo: 1000, label: "$250 to $1,000" },
];

function renderRefund(id: string, f: RefundFacts, arm: "raw" | "digest" | "relative"): string {
  const s = State.create("Larkspur Outfitters approvals desk")
    .field("policy", REFUND_POLICY)
    .section("request")
    .field("request id", id)
    .field("request type", "refund")
    .field("customer tier", tierText(f.tier))
    .field("item", f.item);
  const when = (date: string) =>
    relativeTime(`${date}T00:00:00Z`, Date.parse(`${f.requestedOn}T00:00:00Z`));
  if (arm === "raw") {
    s.field("order delivered on", f.deliveredOn)
      .field("refund requested on", f.requestedOn)
      .field("price paid", usd(f.pricePaid))
      .field("refund amount requested", usd(f.amount));
  } else if (arm === "relative") {
    s.digest("order delivered", `${when(f.deliveredOn)}, relative to the request`)
      .field("price paid", usd(f.pricePaid))
      .field("refund amount requested", usd(f.amount));
  } else {
    const days = daysBetween(`${f.deliveredOn}T00:00:00Z`, `${f.requestedOn}T00:00:00Z`);
    const opts = { actual: "days from delivery to this request", unit: "days" };
    if (f.tier === "VIP-lapsed") {
      s.digest(
        "standard window check",
        compare(days, 30, { ...opts, limit: "standard refund window" }),
      );
      s.digest("VIP window check", compare(days, 60, { ...opts, limit: "VIP refund window" }));
    } else {
      s.digest(
        "window check",
        compare(days, refundWindow(f.tier), { ...opts, limit: "refund window for this tier" }),
      );
    }
    s.digest(
      "amount check",
      compare(f.amount, f.pricePaid, {
        actual: "refund requested",
        limit: "price paid",
        unit: "USD",
      }),
    ).digest("amount band", band(f.amount, AMOUNT_BANDS, "over $1,000"));
  }
  s.field("final sale", yesNo(f.finalSale))
    .field("item condition reported", f.condition)
    .field("order number or receipt on file", yesNo(f.receipt));
  if (arm === "digest") {
    const k = priorsInWindow(f);
    s.digest("refunds issued in the 90 days before this request", count(k, "refund"));
    if (f.tier === "VIP-lapsed") {
      s.digest(
        "standard limit check",
        compare(k + 1, 2, {
          actual: "refunds in 90 days counting this one",
          limit: "standard 90-day limit",
        }),
      );
      s.digest(
        "VIP limit check",
        compare(k + 1, 4, {
          actual: "refunds in 90 days counting this one",
          limit: "VIP 90-day limit",
        }),
      );
    } else {
      s.digest(
        "refund limit check",
        compare(k + 1, refundLimit(f.tier), {
          actual: "refunds in 90 days counting this one",
          limit: "90-day limit for this tier",
        }),
      );
    }
  } else {
    const list = f.priorRefunds
      .map((p) => `${arm === "raw" ? p.on : when(p.on)} (${usd(p.amount)})`)
      .join("; ");
    s.field(
      arm === "raw"
        ? "refunds already issued to this customer"
        : "refunds already issued to this customer, relative to the request",
      list === "" ? "none" : list,
    );
  }
  return s.field("payout method", f.payout).untrusted("customer message", f.message).build().text;
}

function renderExpense(id: string, f: ExpenseFacts, arm: "raw" | "digest" | "relative"): string {
  const s = State.create("Larkspur Outfitters approvals desk")
    .field("policy", EXPENSE_POLICY)
    .section("request")
    .field("request id", id)
    .field("request type", "employee expense claim")
    .field("category", f.category)
    .field("description", f.description);
  if (arm === "raw") {
    s.field("expense date", f.expenseOn).field("submitted on", f.submittedOn);
  } else if (arm === "relative") {
    s.digest(
      "expense date",
      `${relativeTime(`${f.expenseOn}T00:00:00Z`, Date.parse(`${f.submittedOn}T00:00:00Z`))}, relative to submission`,
    );
  } else {
    const days = daysBetween(`${f.expenseOn}T00:00:00Z`, `${f.submittedOn}T00:00:00Z`);
    s.digest(
      "submission check",
      compare(days, 60, {
        actual: "days from expense to submission",
        limit: "submission deadline",
        unit: "days",
      }),
    );
  }
  s.field("amount", usd(f.amount));
  if (arm === "digest") {
    s.digest(
      "receipt threshold check",
      compare(f.amount, 25, { actual: "amount", limit: "receipt threshold", unit: "USD" }),
    ).digest("amount band", band(f.amount, AMOUNT_BANDS, "over $1,000"));
  }
  s.field("receipt attached", yesNo(f.receipt));
  if (f.category === "meal") {
    s.field("attendees", f.attendees ?? 1).field(
      "receipt includes alcohol",
      yesNo(f.alcohol ?? false),
    );
    if (arm === "digest") {
      s.digest(
        "meal limit check",
        compare(perAttendee(f), 75, {
          actual: "cost per attendee",
          limit: "meal limit per attendee",
          unit: "USD",
        }),
      );
    }
  }
  if (f.category === "flight") {
    s.field("cabin class", f.cabin ?? "economy");
    if (arm === "digest") {
      s.digest(
        "flight length check",
        compare(hours(f.flightMinutes ?? 0), 6, {
          actual: "scheduled flight time",
          limit: "business-class threshold",
          unit: "hours",
        }),
      );
    } else {
      s.field("scheduled flight time", `${f.flightMinutes} minutes`);
    }
  }
  if (f.category === "hotel") {
    s.field("nights", f.nights ?? 1)
      .field("hotel city", f.city ?? "")
      .field("city on the high-cost list", yesNo(f.highCost ?? false));
    if (arm === "digest") {
      s.digest(
        "nightly limit check",
        compare(perNight(f), nightlyLimit(f), {
          actual: "cost per night",
          limit: "nightly limit for this city",
          unit: "USD",
        }),
      );
    }
  }
  return s.field("reimbursement method", f.reimbursement).build().text;
}

// ---------------------------------------------------------------------------
// Generation: scenarios shape the distribution, the policy functions set the label.
// ---------------------------------------------------------------------------

const ITEMS: readonly (readonly [string, number, number])[] = [
  ["trail running shoes", 89, 160],
  ["insulated jacket", 120, 320],
  ["daypack", 45, 140],
  ["headlamp", 25, 70],
  ["camp stove", 60, 180],
  ["sleeping bag", 110, 420],
  ["trekking poles", 50, 150],
  ["rain shell", 90, 280],
  ["water filter", 30, 95],
  ["climbing harness", 55, 120],
];
const BIG_ITEMS: readonly (readonly [string, number, number])[] = [
  ["four-season tent", 1050, 1600],
  ["inflatable kayak", 1100, 1900],
  ["avalanche airbag pack", 1020, 1400],
];

const MESSAGES: Readonly<Record<RefundFacts["condition"], readonly string[]>> = {
  unused: [
    "It arrived fine but I ordered the wrong size. Still in the bag with tags.",
    "Changed my mind, never used it. Can I get my money back?",
    "Got this as a duplicate gift. Unopened.",
  ],
  used: [
    "Wore it on two hikes and it just isn't comfortable. Want a refund.",
    "Used it for a weekend trip, not what I expected.",
    "I took it camping once and decided I don't like it.",
  ],
  defective: [
    "The zipper broke the second time I used it.",
    "The seam started leaking on the first rainy day.",
    "It stopped working after one use. Clearly defective.",
  ],
  "opened but unused": [
    "I opened the box to check the color but never used it.",
    "Took it out of the packaging, didn't like it, never used it.",
  ],
};

function priorRefunds(d: Draw, requestedOn: string, inWindow: number, old: number): PriorRefund[] {
  const out: PriorRefund[] = [];
  for (let i = 0; i < inWindow; i++)
    out.push({ on: addDays(requestedOn, -d.int(3, 85)), amount: d.money(15, 180) });
  for (let i = 0; i < old; i++)
    out.push({ on: addDays(requestedOn, -d.int(95, 200)), amount: d.money(15, 180) });
  return out.sort((a, b) => (a.on < b.on ? -1 : 1));
}

interface RefundPlan {
  readonly scenario: string;
  readonly n: number;
  readonly make: (
    d: Draw,
  ) => Partial<RefundFacts> & { days: number; inWindow?: number; old?: number; overBy?: number };
}

const REFUND_PLAN: readonly RefundPlan[] = [
  {
    scenario: "refund-pass",
    n: 37,
    make: (d) => ({
      days: d.chance(0.25) ? d.int(26, 30) : d.int(1, 25),
      inWindow: d.int(0, 1),
      old: d.int(0, 2),
      condition: d.pick(["unused", "unused", "defective"] as const),
    }),
  },
  {
    scenario: "refund-pass-vip-late",
    n: 10,
    make: (d) => ({
      tier: "VIP",
      days: d.chance(0.5) ? d.int(52, 60) : d.int(31, 51),
      inWindow: d.int(0, 3),
    }),
  },
  {
    scenario: "refund-pass-old-priors",
    n: 4,
    make: (d) => ({ tier: "standard", days: d.int(3, 28), inWindow: 1, old: d.int(2, 3) }),
  },
  {
    scenario: "refund-fail-window",
    n: 14,
    make: (d) => ({ tier: "standard", days: d.chance(0.6) ? d.int(31, 36) : d.int(37, 50) }),
  },
  { scenario: "refund-fail-window-vip", n: 4, make: (d) => ({ tier: "VIP", days: d.int(61, 70) }) },
  {
    scenario: "refund-fail-final-sale",
    n: 7,
    make: (d) => ({ days: d.int(2, 28), finalSale: true }),
  },
  { scenario: "refund-fail-used", n: 7, make: (d) => ({ days: d.int(2, 28), condition: "used" }) },
  { scenario: "refund-fail-receipt", n: 6, make: (d) => ({ days: d.int(2, 28), receipt: false }) },
  {
    scenario: "refund-fail-amount",
    n: 6,
    make: (d) => ({ days: d.int(2, 28), overBy: d.money(5, 30) }),
  },
  {
    scenario: "refund-fail-repeat",
    n: 8,
    make: (d) => ({ tier: "standard", days: d.int(2, 28), inWindow: 2, old: d.int(0, 1) }),
  },
  {
    scenario: "refund-fail-repeat-vip",
    n: 2,
    make: (d) => ({ tier: "VIP", days: d.int(2, 40), inWindow: 4 }),
  },
  {
    scenario: "refund-ambiguous-opened",
    n: 3,
    make: (d) => ({ days: d.int(3, 27), condition: "opened but unused" }),
  },
  {
    scenario: "refund-ambiguous-lapsed-vip",
    n: 2,
    make: (d) => ({ tier: "VIP-lapsed", days: d.int(38, 55) }),
  },
];

function makeRefund(d: Draw, plan: RefundPlan): RefundFacts {
  const p = plan.make(d);
  const big = d.chance(0.08);
  const [item, lo, hi] = d.pick(big ? BIG_ITEMS : ITEMS);
  const pricePaid = d.money(lo, hi);
  const partial = d.chance(0.2) && p.overBy === undefined;
  const amount =
    p.overBy !== undefined
      ? Math.round((pricePaid + p.overBy) * 100) / 100
      : partial
        ? Math.round(pricePaid * d.pick([0.5, 0.6, 0.75]) * 100) / 100
        : pricePaid;
  const requestedOn = dateBetween(d, "2026-08-01", "2026-11-10");
  const condition = p.condition ?? d.pick(["unused", "defective"] as const);
  const payout = d.chance(0.06)
    ? "wire transfer"
    : d.pick(["original card", "original card", "store credit"] as const);
  return {
    kind: "refund",
    tier: p.tier ?? (d.chance(0.15) ? "VIP" : "standard"),
    item,
    deliveredOn: addDays(requestedOn, -p.days),
    requestedOn,
    pricePaid,
    amount,
    finalSale: p.finalSale ?? false,
    condition,
    receipt: p.receipt ?? true,
    priorRefunds: priorRefunds(d, requestedOn, p.inWindow ?? 0, p.old ?? 0),
    payout,
    message: d.pick(MESSAGES[condition]),
  };
}

interface ExpensePlan {
  readonly scenario: string;
  readonly n: number;
  readonly make: (d: Draw) => Omit<
    ExpenseFacts,
    "kind" | "expenseOn" | "submittedOn" | "reimbursement"
  > & {
    days?: number;
  };
}

const CITIES = ["Denver", "Portland", "Boise", "Salt Lake City", "Spokane", "Reno"];
const HIGH_COST = ["San Francisco", "New York", "Boston", "Seattle"];

const meal = (d: Draw, perHead: number, attendees: number, extra: Partial<ExpenseFacts> = {}) => ({
  category: "meal" as const,
  description: d.pick([
    "client dinner",
    "team lunch",
    "working dinner with a supplier",
    "breakfast meeting with a retailer",
  ]),
  amount: Math.round(perHead * attendees * 100) / 100,
  attendees,
  receipt: true,
  alcohol: false,
  ...extra,
});

const EXPENSE_PLAN: readonly ExpensePlan[] = [
  {
    scenario: "meal-pass",
    n: 15,
    make: (d) => meal(d, d.chance(0.4) ? d.money(70, 75) : d.money(30, 69), d.int(1, 6)),
  },
  {
    scenario: "meal-fail-over",
    n: 9,
    make: (d) => meal(d, d.chance(0.6) ? d.money(75.5, 80) : d.money(80, 95), d.int(2, 6)),
  },
  {
    scenario: "meal-fail-alcohol",
    n: 5,
    make: (d) => meal(d, d.money(35, 70), d.int(2, 5), { alcohol: true }),
  },
  {
    scenario: "meal-fail-receipt",
    n: 3,
    make: (d) => meal(d, d.money(30, 60), d.int(1, 3), { receipt: false }),
  },
  {
    scenario: "meal-pass-small-no-receipt",
    n: 2,
    make: (d) =>
      meal(d, d.money(8, 24.5), 1, { receipt: false, description: "coffee with a supplier" }),
  },
  {
    scenario: "flight-pass-economy",
    n: 8,
    make: (d) => ({
      category: "flight",
      description: d.pick([
        "flight to the Denver trade show",
        "flight to a supplier visit",
        "flight to the regional sales meeting",
      ]),
      amount: d.money(180, 900),
      receipt: true,
      cabin: "economy",
      flightMinutes: d.int(70, 600),
    }),
  },
  {
    scenario: "flight-pass-business-long",
    n: 7,
    make: (d) => ({
      category: "flight",
      description: d.pick([
        "flight to the Tokyo distributor",
        "flight to the Frankfurt outdoor fair",
        "flight to the Sydney supplier",
      ]),
      amount: d.money(1400, 2600),
      receipt: true,
      cabin: "business",
      flightMinutes: d.chance(0.4) ? d.int(361, 400) : d.int(401, 720),
    }),
  },
  {
    scenario: "flight-fail-business-short",
    n: 8,
    make: (d) => ({
      category: "flight",
      description: d.pick([
        "flight to the Chicago sales meeting",
        "flight to the Atlanta retailer visit",
        "flight to the Dallas trade show",
      ]),
      amount: d.money(700, 1500),
      receipt: true,
      cabin: "business",
      flightMinutes: d.chance(0.25) ? 360 : d.chance(0.5) ? d.int(330, 359) : d.int(150, 329),
    }),
  },
  {
    scenario: "flight-ambiguous-free-upgrade",
    n: 2,
    make: (d) => ({
      category: "flight",
      description: "flight to the Phoenix retailer visit",
      amount: d.money(300, 600),
      receipt: true,
      cabin: "business (upgrade at no extra cost)",
      flightMinutes: d.int(110, 200),
    }),
  },
  {
    scenario: "hotel-pass",
    n: 11,
    make: (d) => {
      const nights = d.int(1, 7);
      return {
        category: "hotel",
        description: "hotel for a trade show",
        nights,
        amount:
          Math.round((d.chance(0.4) ? d.money(235, 250) : d.money(120, 234)) * nights * 100) / 100,
        receipt: true,
        city: d.pick(CITIES),
        highCost: false,
      };
    },
  },
  {
    scenario: "hotel-fail-over",
    n: 9,
    make: (d) => {
      const nights = d.int(1, 7);
      return {
        category: "hotel",
        description: "hotel for a customer visit",
        nights,
        amount:
          Math.round((d.chance(0.6) ? d.money(251, 265) : d.money(266, 330)) * nights * 100) / 100,
        receipt: true,
        city: d.pick(CITIES),
        highCost: false,
      };
    },
  },
  {
    scenario: "hotel-pass-high-cost",
    n: 4,
    make: (d) => {
      const nights = d.int(1, 5);
      return {
        category: "hotel",
        description: "hotel for a trade show",
        nights,
        amount: Math.round(d.money(260, 350) * nights * 100) / 100,
        receipt: true,
        city: d.pick(HIGH_COST),
        highCost: true,
      };
    },
  },
  {
    scenario: "hotel-fail-high-cost",
    n: 2,
    make: (d) => {
      const nights = d.int(1, 4);
      return {
        category: "hotel",
        description: "hotel for a customer visit",
        nights,
        amount: Math.round(d.money(351, 380) * nights * 100) / 100,
        receipt: true,
        city: d.pick(HIGH_COST),
        highCost: true,
      };
    },
  },
  {
    scenario: "taxi-pass-receipt",
    n: 5,
    make: (d) => ({
      category: "taxi",
      description: "taxi from the airport",
      amount: d.money(25, 90),
      receipt: true,
    }),
  },
  {
    scenario: "taxi-pass-small-no-receipt",
    n: 4,
    make: (d) => ({
      category: "taxi",
      description: "taxi across town",
      amount: d.money(8, 24.99),
      receipt: false,
    }),
  },
  {
    scenario: "taxi-fail-no-receipt",
    n: 5,
    make: (d) => ({
      category: "taxi",
      description: "taxi to a client office",
      amount: d.chance(0.25) ? 25 : d.money(26, 45),
      receipt: false,
    }),
  },
  {
    scenario: "late-submission",
    n: 10,
    make: (d) => ({
      ...meal(d, d.money(30, 70), d.int(1, 4)),
      days: d.chance(0.6) ? d.int(61, 66) : d.int(67, 80),
    }),
  },
];

function makeExpense(d: Draw, plan: ExpensePlan): ExpenseFacts {
  const { days: forced, ...p } = plan.make(d);
  const submittedOn = dateBetween(d, "2026-08-01", "2026-11-10");
  const days = forced ?? (d.chance(0.2) ? d.int(54, 60) : d.int(1, 53));
  return {
    kind: "expense",
    ...p,
    expenseOn: addDays(submittedOn, -days),
    submittedOn,
    reimbursement: d.chance(0.06) ? "wire transfer to an external account" : "payroll",
  };
}

const AMBIGUOUS = new Set([
  "refund-ambiguous-opened",
  "refund-ambiguous-lapsed-vip",
  "flight-ambiguous-free-upgrade",
]);

export function buildApprovals(seed = 31): ApprovalItem[] {
  const d = new Draw(seed);
  const items: ApprovalItem[] = [];
  const ids = new Set<string>();
  const freshId = (prefix: string): string => {
    for (;;) {
      const id = opaqueId(d, prefix);
      if (!ids.has(id)) {
        ids.add(id);
        return id;
      }
    }
  };
  for (const plan of REFUND_PLAN) {
    for (let i = 0; i < plan.n; i++) {
      const f = makeRefund(d, plan);
      const v = refundVerdict(f);
      const id = freshId("REF");
      items.push({
        id,
        scenario: plan.scenario,
        facts: f,
        label: label(v.ok, `${v.ok ? "approve" : "deny"}: ${v.why}`, AMBIGUOUS.has(plan.scenario)),
        floor: { overLimit: f.amount > REFUND_HARD_LIMIT, wire: f.payout === "wire transfer" },
        states: {
          raw: renderRefund(id, f, "raw"),
          digest: renderRefund(id, f, "digest"),
          relative: renderRefund(id, f, "relative"),
        },
      });
    }
  }
  for (const plan of EXPENSE_PLAN) {
    for (let i = 0; i < plan.n; i++) {
      const f = makeExpense(d, plan);
      const v = expenseVerdict(f);
      const id = freshId("EXP");
      items.push({
        id,
        scenario: plan.scenario,
        facts: f,
        label: label(v.ok, `${v.ok ? "approve" : "deny"}: ${v.why}`, AMBIGUOUS.has(plan.scenario)),
        floor: { overLimit: f.amount > EXPENSE_HARD_LIMIT, wire: f.reimbursement !== "payroll" },
        states: {
          raw: renderExpense(id, f, "raw"),
          digest: renderExpense(id, f, "digest"),
          relative: renderExpense(id, f, "relative"),
        },
      });
    }
  }
  // Interleave refunds and expenses so ledger order is not grouped by scenario.
  return d.shuffle(items);
}
