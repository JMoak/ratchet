/**
 * Unit and currency conversion. The application holds the rates and the raw amounts, so it can
 * compute the converted figures in code; the digested view hands those to the verifier, the raw
 * view leaves the arithmetic to the model. Same candidates, same labels, two renderings.
 */
import type { Rand } from "../../../../src/math.ts";
import type { Person } from "../pools.ts";
import {
  int,
  iso,
  money,
  offByOne,
  people,
  pickOne,
  randomDate,
  round1,
  round2,
  sample,
  transposeDigits,
} from "../pools.ts";
import { type Candidate, type Digest, ERROR_TYPES, type Family, type Variant } from "../types.ts";

const EXPENSES = [
  "Hotel, Boston",
  "Train, London",
  "Taxi, Tokyo",
  "Client dinner, Zurich",
  "Conference fee, Austin",
  "Car hire, Edinburgh",
] as const;

const CURRENCY_OF: Readonly<Record<(typeof EXPENSES)[number], "USD" | "GBP" | "JPY" | "CHF">> = {
  "Hotel, Boston": "USD",
  "Train, London": "GBP",
  "Taxi, Tokyo": "JPY",
  "Client dinner, Zurich": "CHF",
  "Conference fee, Austin": "USD",
  "Car hire, Edinburgh": "GBP",
};

const expense: Family = {
  id: "convert.expense",
  domain: "convert",
  split: "fit",
  errors: ERROR_TYPES,
  make(r) {
    const [emp] = people(r, 1) as [Person];
    const rateDate = randomDate(r, 2026);
    const rates = {
      USD: int(r, 8800, 9600) / 10000,
      GBP: int(r, 11200, 12000) / 10000,
      JPY: int(r, 5800, 6600) / 10000, // per 100 JPY
      CHF: int(r, 10200, 10800) / 10000,
    };
    const picks = sample(r, EXPENSES, 3);
    const lines = picks.map((label) => {
      const cur = CURRENCY_OF[label];
      const amount = cur === "JPY" ? int(r, 20, 400) * 100 : round2(int(r, 2000, 90000) / 100);
      const eur = round2(cur === "JPY" ? (amount / 100) * rates.JPY : amount * rates[cur]);
      return { label, cur, amount, eur };
    });
    const total = round2(lines.reduce((s, l) => s + l.eur, 0));
    const sheet = [
      `Treasury desk rate sheet, ${iso(rateDate)} (rates exclude bank charges)`,
      `1 USD = ${rates.USD.toFixed(4)} EUR`,
      `1 GBP = ${rates.GBP.toFixed(4)} EUR`,
      `100 JPY = ${rates.JPY.toFixed(4)} EUR`,
      `1 CHF = ${rates.CHF.toFixed(4)} EUR`,
    ].join("\n");
    const claim = [
      `Employee: ${emp.full}`,
      ...lines.map(
        (l) => `${l.label}: ${l.cur} ${l.cur === "JPY" ? money(l.amount, 0) : money(l.amount)}`,
      ),
    ].join("\n");
    const digests: Digest[] = [
      ...lines.map((l, i) => ({
        name: `computed_eur_line_${i + 1}`,
        value: `${l.label} = EUR ${money(l.eur)}`,
      })),
      { name: "computed_eur_total", value: `EUR ${money(total)}` },
    ];
    const request =
      "Write the reimbursement message to the employee: list each expense converted to EUR at the " +
      "rate sheet's rates (rounded to cents), give the EUR total, and name the rate sheet and its date.";
    const fmt = (x: number, d = 2): string => `EUR ${money(x, d)}`;
    const compose = (o: {
      readonly eur?: readonly string[];
      readonly labels?: readonly string[];
      readonly total?: string | null;
      readonly date?: string;
      readonly sheetName?: string;
      readonly charges?: string;
      readonly tail?: string;
    }): string => {
      const parts = lines.map((l, i) => `${o.labels?.[i] ?? l.label} ${o.eur?.[i] ?? fmt(l.eur)}`);
      const head = `Hi ${emp.first}, here are your expenses converted at the ${o.sheetName ?? "Treasury desk"} rates of ${o.date ?? iso(rateDate)}, which ${o.charges ?? "exclude"} bank charges: ${parts.join("; ")}.`;
      const tot = o.total === null ? "" : ` Total: ${o.total ?? fmt(total)}.`;
      return `${head}${tot}${o.tail ?? ""}`;
    };
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: "correct: every line converted at the sheet rate, total, sheet and date",
          };
        case "benign":
          return {
            text: compose({
              eur: lines.map((l) => `€${money(l.eur)}`),
              total: `€${money(total)}`,
            }),
            why: "correct: euro sign instead of the EUR code",
          };
        case "paraphrase":
          return {
            text:
              `Hello ${emp.first}. Using the Treasury desk rate sheet dated ${iso(rateDate)} (bank charges excluded), your claim comes to ${fmt(total)} in total. ` +
              `Breakdown: ${lines
                .slice()
                .reverse()
                .map((l) => `${fmt(l.eur)} for ${l.label}`)
                .join(", ")}.`,
            why: "correct: reworded, total first, lines in reverse order",
          };
        case "wrong_number": {
          const k = int(rr, 0, lines.length - 1);
          const line = lines[k] as (typeof lines)[number];
          const bad = transposeDigits(money(line.eur), rr);
          return {
            text: compose({ eur: lines.map((l, i) => (i === k ? `EUR ${bad}` : fmt(l.eur))) }),
            why: `${line.label} should be EUR ${money(line.eur)}, output says EUR ${bad}`,
          };
        }
        case "missing_requirement":
          return { text: compose({ total: null }), why: "the EUR total is left out" };
        case "unsupported_claim":
          return {
            text: compose({ tail: " This will be paid with your March salary." }),
            why: "says when it will be paid; nothing in the sources says so",
          };
        case "wrong_entity": {
          const labels = lines.map((l) => l.label);
          const swapped = [labels[1], labels[0], ...labels.slice(2)] as string[];
          return {
            text: compose({ labels: swapped }),
            why: "the first two expense labels are swapped against their amounts",
          };
        }
        case "date_off_by_one": {
          const d = iso(offByOne(rateDate, rr));
          return {
            text: compose({ date: d }),
            why: `rate sheet date ${iso(rateDate)} given as ${d}`,
          };
        }
        case "unit_slip": {
          const k = int(rr, 0, lines.length - 1);
          const line = lines[k] as (typeof lines)[number];
          const raw = line.cur === "JPY" ? money(line.amount, 0) : money(line.amount);
          return {
            text: compose({ eur: lines.map((l, i) => (i === k ? `EUR ${raw}` : fmt(l.eur))) }),
            why: `${line.label} shows its unconverted ${line.cur} amount ${raw} labelled EUR`,
          };
        }
        case "format_violation": {
          const unrounded = lines.map((l) =>
            l.cur === "JPY" ? (l.amount / 100) * rates.JPY : l.amount * rates[l.cur],
          );
          return {
            text: compose({
              eur: unrounded.map((x) => `EUR ${x.toFixed(4)}`),
              total: `EUR ${unrounded.reduce((s, x) => s + x, 0).toFixed(4)}`,
            }),
            why: "amounts given to four decimals where rounding to cents was required",
          };
        }
        case "fabricated_citation":
          return {
            text: compose({ sheetName: "ECB reference" }),
            why: "attributes the rates to the ECB; the sheet is the Treasury desk's",
          };
        case "negation":
          return {
            text: compose({ charges: "include" }),
            why: "says the rates include bank charges; the sheet says they exclude them",
          };
      }
    };
    return {
      task: {
        request,
        sources: [
          { name: "rate_sheet", text: sheet },
          { name: "expense_claim", text: claim },
        ],
        digests,
      },
      render,
    };
  },
};

const ITEMS = [
  { code: "FW-200", name: "folding workbench" },
  { code: "TC-90", name: "tool chest" },
  { code: "SR-45", name: "shelving rack" },
  { code: "MC-12", name: "mobile cart" },
  { code: "SB-70", name: "storage bench" },
] as const;

const dimensions: Family = {
  id: "convert.dimensions",
  domain: "convert",
  split: "heldout",
  errors: ERROR_TYPES,
  make(r) {
    const item = pickOne(r, ITEMS);
    const rev = randomDate(r, 2026);
    const L = int(r, 200, 700) / 10;
    const W = int(r, 120, Math.min(450, Math.round(L * 10) - 20)) / 10;
    const H = int(r, 30, 90) / 10;
    const lb = int(r, 80, 900) / 10;
    const load = int(r, 15, 90) * 10;
    const stackable = r() < 0.5;
    const cm = (x: number): number => round1(x * 2.54);
    const kg = (x: number): number => round1(x * 0.45359237);
    const spec = [
      `Product: ${item.code} ${item.name}`,
      `Spec sheet revision: ${iso(rev)}`,
      `Folded dimensions: ${L.toFixed(1)} in long x ${W.toFixed(1)} in wide x ${H.toFixed(1)} in high`,
      `Weight: ${lb.toFixed(1)} lb`,
      `Load rating: ${load} lb`,
      `Stackable: ${stackable ? "yes" : "no"}`,
    ].join("\n");
    const digests: Digest[] = [
      { name: "computed_length_cm", value: cm(L).toFixed(1) },
      { name: "computed_width_cm", value: cm(W).toFixed(1) },
      { name: "computed_height_cm", value: cm(H).toFixed(1) },
      { name: "computed_weight_kg", value: kg(lb).toFixed(1) },
      { name: "computed_load_rating_kg", value: kg(load).toFixed(1) },
    ];
    const request =
      "Write the product listing line in metric units: folded length, width and height in cm and " +
      "the weight in kg, each to one decimal place, the load rating in kg to one decimal place, " +
      "whether it is stackable, and the spec sheet revision date.";
    const compose = (o: {
      readonly dims?: string;
      readonly weight?: string;
      readonly load?: string | null;
      readonly stack?: boolean;
      readonly date?: string;
      readonly code?: string;
      readonly tail?: string;
    }): string =>
      `${o.code ?? item.code} ${item.name}, spec rev. ${o.date ?? iso(rev)}: folded ${o.dims ?? `${cm(L).toFixed(1)} x ${cm(W).toFixed(1)} x ${cm(H).toFixed(1)} cm (L x W x H)`}, ` +
      `${o.weight ?? `${kg(lb).toFixed(1)} kg`}${o.load === null ? "" : `, load rating ${o.load ?? `${kg(load).toFixed(1)} kg`}`}, ${(o.stack ?? stackable) ? "stackable" : "not stackable"}.${o.tail ?? ""}`;
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: "correct: every figure converted and rounded, stackability and date",
          };
        case "benign":
          return {
            text: plain.replace(/ x /g, " × "),
            why: "correct: multiplication signs instead of the letter x",
          };
        case "paraphrase":
          return {
            text:
              `Metric listing for the ${item.code} ${item.name} (spec revision ${iso(rev)}): it folds to ${cm(L).toFixed(1)} cm long, ${cm(W).toFixed(1)} cm wide and ${cm(H).toFixed(1)} cm high, ` +
              `weighs ${kg(lb).toFixed(1)} kg, is rated to carry ${kg(load).toFixed(1)} kg, and ${stackable ? "can be stacked" : "cannot be stacked"}.`,
            why: "correct: reworded as a sentence, same figures",
          };
        case "wrong_number": {
          const bad = round1(kg(lb) + pickOne(rr, [0.4, 0.7, -0.3, 1.1]));
          return {
            text: compose({ weight: `${bad.toFixed(1)} kg` }),
            why: `weight ${kg(lb).toFixed(1)} kg given as ${bad.toFixed(1)} kg`,
          };
        }
        case "missing_requirement":
          return { text: compose({ load: null }), why: "the load rating is left out" };
        case "unsupported_claim":
          return {
            text: compose({ tail: " Fits a standard EU pallet." }),
            why: "claims it fits an EU pallet, which the spec does not say",
          };
        case "wrong_entity":
          return {
            text: compose({
              dims: `${cm(W).toFixed(1)} x ${cm(L).toFixed(1)} x ${cm(H).toFixed(1)} cm (L x W x H)`,
            }),
            why: "length and width are swapped under the L x W x H label",
          };
        case "date_off_by_one": {
          const d = iso(offByOne(rev, rr));
          return { text: compose({ date: d }), why: `revision date ${iso(rev)} given as ${d}` };
        }
        case "unit_slip":
          return {
            text: compose({ weight: `${lb.toFixed(1)} kg` }),
            why: `weight shows the pound figure ${lb.toFixed(1)} labelled kg`,
          };
        case "format_violation":
          return {
            text: compose({
              dims: `${(L * 2.54).toFixed(2)} x ${(W * 2.54).toFixed(2)} x ${(H * 2.54).toFixed(2)} cm (L x W x H)`,
              weight: `${(lb * 0.45359237).toFixed(2)} kg`,
              load: `${(load * 0.45359237).toFixed(2)} kg`,
            }),
            why: "figures given to two decimals where one decimal place was required",
          };
        case "fabricated_citation":
          return {
            text: compose({ tail: " Tested to EN 1729." }),
            why: "cites a test standard the spec sheet never mentions",
          };
        case "negation":
          return {
            text: compose({ stack: !stackable }),
            why: `stackability reversed; spec says ${stackable ? "yes" : "no"}`,
          };
      }
    };
    return { task: { request, sources: [{ name: "spec_sheet", text: spec }], digests }, render };
  },
};

const payroll: Family = {
  id: "convert.payroll",
  domain: "convert",
  split: "challenge",
  errors: ERROR_TYPES,
  make(r) {
    const [who, approver] = people(r, 2) as [Person, Person];
    const rateDate = randomDate(r, 2026);
    const hours = 40 + int(r, 3, 24) / 2;
    const rate = int(r, 25, 70);
    const fx = int(r, 12400, 13100) / 10000;
    const regular = round2(40 * rate);
    const overtime = round2((hours - 40) * rate * 1.5);
    const gross = round2(regular + overtime);
    const usd = round2(gross * fx);
    const fee = round2(usd * 0.02);
    const net = round2(usd - fee);
    const sheet = [
      `Contractor: ${who.full}`,
      `Hours this period: ${hours.toFixed(1)} (overtime approved by ${approver.full})`,
      `Base rate: GBP ${money(rate)} per hour for the first 40 hours; hours beyond 40 at 1.5 times the base rate.`,
      `Conversion: GBP to USD at 1 GBP = ${fx.toFixed(4)} USD (desk rate of ${iso(rateDate)}).`,
      "Platform fee: 2% of the USD gross, deducted from the payout.",
    ].join("\n");
    const digests: Digest[] = [
      { name: "computed_regular_gbp", value: money(regular) },
      { name: "computed_overtime_gbp", value: money(overtime) },
      { name: "computed_gross_usd", value: money(usd) },
      { name: "computed_fee_usd", value: money(fee) },
      { name: "computed_net_usd", value: money(net) },
    ];
    const request =
      "Write the payment confirmation for the contractor: regular and overtime pay in GBP, the gross " +
      "converted to USD at the stated rate, the 2% platform fee in USD, and the net USD payout, all " +
      "to cents, with the rate date.";
    const compose = (o: {
      readonly reg?: string;
      readonly ot?: string;
      readonly usd?: string;
      readonly fee?: string | null;
      readonly net?: string;
      readonly date?: string;
      readonly src?: string;
      readonly deducted?: string;
      readonly name?: string;
      readonly tail?: string;
    }): string =>
      `Hi ${o.name ?? who.first}, for ${hours.toFixed(1)} hours you earned GBP ${o.reg ?? money(regular)} regular and GBP ${o.ot ?? money(overtime)} overtime pay. ` +
      `At the ${o.src ?? "desk"} rate of ${o.date ?? iso(rateDate)} the gross is USD ${o.usd ?? money(usd)}` +
      `${o.fee === null ? "" : `; the 2% platform fee of USD ${o.fee ?? money(fee)} ${o.deducted ?? "is deducted"}`}, so your net payout is USD ${o.net ?? money(net)}.${o.tail ?? ""}`;
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: "correct: regular, overtime, USD gross, fee and net all right",
          };
        case "benign":
          return {
            text: plain.replace(/USD /g, "US$"),
            why: "correct: US$ instead of the USD code",
          };
        case "paraphrase":
          return {
            text:
              `${who.first}, your net payout is USD ${money(net)}. It comes from GBP ${money(regular)} for the first 40 hours plus GBP ${money(overtime)} of overtime, ` +
              `converted at the ${iso(rateDate)} desk rate to USD ${money(usd)}, less the 2% platform fee of USD ${money(fee)}.`,
            why: "correct: reworded, net first, same figures",
          };
        case "wrong_number": {
          const badOt = round2((hours - 40) * rate * 1.25);
          return {
            text: compose({ ot: money(badOt) }),
            why: `overtime computed at 1.25x (GBP ${money(badOt)}); at 1.5x it is GBP ${money(overtime)}`,
          };
        }
        case "missing_requirement":
          return { text: compose({ fee: null }), why: "the platform fee is left out" };
        case "unsupported_claim":
          return {
            text: compose({ tail: " Funds arrive within two business days." }),
            why: "promises arrival within two days; nothing says so",
          };
        case "wrong_entity":
          return {
            text: compose({ reg: money(overtime), ot: money(regular) }),
            why: "regular and overtime amounts are swapped",
          };
        case "date_off_by_one": {
          const d = iso(offByOne(rateDate, rr));
          return { text: compose({ date: d }), why: `rate date ${iso(rateDate)} given as ${d}` };
        }
        case "unit_slip":
          return {
            text: compose({ usd: money(gross) }),
            why: `USD gross shows the unconverted GBP figure ${money(gross)}`,
          };
        case "format_violation":
          return {
            text: compose({
              reg: money(regular, 0),
              ot: money(overtime, 0),
              usd: money(usd, 0),
              fee: money(fee, 0),
              net: money(net, 0),
            }),
            why: "amounts rounded to whole units where cents were required",
          };
        case "fabricated_citation":
          return {
            text: compose({ src: "Bank of England" }),
            why: "attributes the rate to the Bank of England; the sheet gives a desk rate",
          };
        case "negation":
          return {
            text: compose({ deducted: "is not deducted" }),
            why: "says the fee is not deducted; the sheet says it is",
          };
      }
    };
    return { task: { request, sources: [{ name: "timesheet", text: sheet }], digests }, render };
  },
};

export const convertFamilies: readonly Family[] = [expense, dimensions, payroll];
