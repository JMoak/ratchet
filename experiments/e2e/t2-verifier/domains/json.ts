/**
 * Document to JSON extraction. The application holds the document; the proposer returns a JSON
 * object; the verifier checks keys, values and formats against the document. Distractor
 * entities (ship-to party, notify party, guarantor) sit in every document so a wrong-entity
 * error has something plausible to pick.
 */
import type { Rand } from "../../../../src/math.ts";
import type { Person } from "../pools.ts";
import {
  addDays,
  CARRIERS,
  CITIES,
  COMPANIES,
  day,
  int,
  iso,
  longDate,
  money,
  offByOne,
  PRODUCTS,
  people,
  pickOne,
  randomDate,
  round1,
  round2,
  sample,
  slashDate,
  transposeDigits,
  usDate,
} from "../pools.ts";
import { type Candidate, ERROR_TYPES, type Family, type Variant } from "../types.ts";

type J = string | number | boolean | null | { readonly raw: string };
type Entry = readonly [string, J];

const lit = (v: J): string =>
  v === null ? "null" : typeof v === "object" ? v.raw : JSON.stringify(v);

function obj(entries: readonly Entry[], compact = false): string {
  const parts = entries.map(([k, v]) => `${JSON.stringify(k)}: ${lit(v)}`);
  return compact ? `{${parts.join(", ")}}` : `{\n  ${parts.join(",\n  ")}\n}`;
}

const set = (entries: readonly Entry[], key: string, v: J): Entry[] =>
  entries.map(([k, old]) => [k, k === key ? v : old] as const);
const drop = (entries: readonly Entry[], key: string): Entry[] =>
  entries.filter(([k]) => k !== key);
const fixed2 = (x: number): J => ({ raw: x.toFixed(2) });

/** The two correct styles every JSON family shares: plain, and compact with keys reordered. */
function correct(entries: readonly Entry[], v: "plain" | "benign", r: Rand): Candidate {
  if (v === "plain") return { text: obj(entries), why: "correct: every key and value matches" };
  const moved = entries.slice();
  const i = int(r, 0, moved.length - 2);
  const a = moved[i] as Entry;
  moved[i] = moved[i + 1] as Entry;
  moved[i + 1] = a;
  return {
    text: obj(moved, true),
    why: "correct: compact JSON, two adjacent keys swapped in order (no order or layout was required)",
  };
}

const NOTES = [
  { text: "Deliver to loading dock 3.", para: "Delivery goes to loading dock 3." },
  {
    text: "Call the site office 30 minutes before arrival.",
    para: "Phone the site office half an hour before arriving.",
  },
  {
    text: "Leave pallets inside the gated yard.",
    para: "Pallets should be left within the gated yard.",
  },
  {
    text: "Use the north entrance; the south gate is closed for works.",
    para: "Enter by the north entrance because the south gate is closed for works.",
  },
] as const;

const EXTRA_INVOICE = [
  "Customer is VAT-exempt.",
  "A 2% early-payment discount applies.",
  "Goods are insured in transit by the vendor.",
] as const;

const invoice: Family = {
  id: "json.invoice",
  domain: "json",
  split: "fit",
  errors: ERROR_TYPES,
  make(r) {
    const [vendor, customer, shipTo] = sample(r, COMPANIES, 3) as [string, string, string];
    const currency = pickOne(r, ["EUR", "USD", "GBP", "CAD"] as const);
    const issue = randomDate(r, 2026);
    const terms = pickOne(r, [14, 30, 45]);
    const due = addDays(issue, terms);
    const lines = sample(r, PRODUCTS, int(r, 2, 4)).map((desc) => {
      const qty = int(r, 1, 12);
      const unit = round2(int(r, 500, 40000) / 100);
      return { desc, qty, unit, amount: round2(qty * unit) };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxRate = pickOne(r, [8, 10, 20]);
    const tax = round2((subtotal * taxRate) / 100);
    const total = round2(subtotal + tax);
    const paid = r() < 0.5;
    const note = pickOne(r, NOTES);
    const invNo = `INV-2026-${int(r, 10000, 99999)}`;
    const doc = [
      `INVOICE ${invNo}`,
      `From: ${vendor}, ${pickOne(r, CITIES)}`,
      `Bill to: ${customer}`,
      `Ship to: ${shipTo} (receiving agent)`,
      `Issue date: ${longDate(issue)}`,
      `Payment due: ${terms} days from issue (${longDate(due)})`,
      `Currency: ${currency}`,
      "",
      ...lines.map((l) => `${l.desc}: ${l.qty} x ${money(l.unit)} = ${money(l.amount)}`),
      `Subtotal: ${money(subtotal)}`,
      `Tax (${taxRate}%): ${money(tax)}`,
      `Total due: ${money(total)}`,
      "",
      `Status: ${paid ? "Paid in full" : "Outstanding"}`,
      `Note: ${note.text}`,
    ].join("\n");
    const request =
      "Extract this invoice as a JSON object with exactly these keys: invoice_number, vendor, " +
      "customer (the bill-to party), issue_date and due_date (both YYYY-MM-DD), currency (ISO " +
      "4217 code), total (the total due, as a number), paid (true or false), notes (the " +
      "handling note on the invoice, or null if there is none).";
    const base: Entry[] = [
      ["invoice_number", invNo],
      ["vendor", vendor],
      ["customer", customer],
      ["issue_date", iso(issue)],
      ["due_date", iso(due)],
      ["currency", currency],
      ["total", fixed2(total)],
      ["paid", paid],
      ["notes", note.text],
    ];
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
        case "benign":
          return correct(base, v, rr);
        case "paraphrase":
          return {
            text: obj(set(base, "notes", note.para)),
            why: "correct: notes reworded with the same meaning",
          };
        case "wrong_number": {
          const bad =
            rr() < 0.5 ? subtotal : Number(transposeDigits(total.toFixed(2), rr).replace(/,/g, ""));
          return {
            text: obj(set(base, "total", fixed2(bad))),
            why: `total ${total.toFixed(2)} given as ${bad.toFixed(2)}`,
          };
        }
        case "missing_requirement":
          return { text: obj(drop(base, "due_date")), why: "required key due_date is missing" };
        case "unsupported_claim": {
          const extra = pickOne(rr, EXTRA_INVOICE);
          return {
            text: obj(set(base, "notes", `${note.text} ${extra}`)),
            why: `notes add "${extra}", which the invoice does not say`,
          };
        }
        case "wrong_entity":
          return rr() < 0.5
            ? {
                text: obj(set(base, "customer", shipTo)),
                why: `customer is the ship-to agent ${shipTo}, not the bill-to party ${customer}`,
              }
            : {
                text: obj(set(set(base, "customer", vendor), "vendor", customer)),
                why: "vendor and customer are swapped",
              };
        case "date_off_by_one": {
          const d = offByOne(due, rr);
          return {
            text: obj(set(base, "due_date", iso(d))),
            why: `due_date ${iso(due)} given as ${iso(d)}`,
          };
        }
        case "unit_slip": {
          const other = pickOne(
            rr,
            ["EUR", "USD", "GBP", "CAD"].filter((c) => c !== currency),
          );
          return {
            text: obj(set(base, "currency", other)),
            why: `currency is ${currency} on the invoice, output says ${other}`,
          };
        }
        case "format_violation":
          return {
            text: obj(set(set(base, "issue_date", slashDate(issue)), "due_date", slashDate(due))),
            why: "dates written DD/MM/YYYY where YYYY-MM-DD was required",
          };
        case "fabricated_citation": {
          const clause = int(rr, 4, 19);
          return {
            text: obj(
              set(
                base,
                "notes",
                `${note.text} (per clause ${clause} of the master supply agreement)`,
              ),
            ),
            why: `notes cite clause ${clause} of a supply agreement the invoice never mentions`,
          };
        }
        case "negation":
          return {
            text: obj(set(base, "paid", !paid)),
            why: `paid is ${!paid} but the invoice says ${paid ? "Paid in full" : "Outstanding"}`,
          };
      }
    };
    return { task: { request, sources: [{ name: "invoice", text: doc }] }, render };
  },
};

const HANDLING = [
  { text: "Keep dry.", para: "Must be kept dry." },
  { text: "Do not stack more than two pallets high.", para: "Stack no higher than two pallets." },
  { text: "Fragile: glassware.", para: "Contains glassware; handle as fragile." },
] as const;

const EXTRA_HANDLING = [
  "Signature required on delivery.",
  "Temperature-controlled trailer required.",
  "Liftgate delivery booked.",
] as const;

const shipping: Family = {
  id: "json.shipping",
  domain: "json",
  split: "heldout",
  errors: ERROR_TYPES,
  make(r) {
    const [shipper, consignee, notify] = sample(r, COMPANIES, 3) as [string, string, string];
    const carrier = pickOne(r, CARRIERS);
    const prefix = carrier
      .split(" ")
      .map((w) => w[0])
      .join("");
    const tracking = `${prefix}${int(r, 100000, 999999)}${int(r, 1000, 9999)}`;
    const shipDate = randomDate(r, 2026);
    const transit = int(r, 4, 21);
    const eta = addDays(shipDate, transit);
    const cartons = int(r, 6, 60);
    const pallets = Math.max(1, Math.round(cartons / int(r, 6, 12)));
    const kg = round1(int(r, 900, 9000) / 10);
    const lb = round1(kg * 2.20462);
    const hazardous = r() < 0.4;
    const handling = pickOne(r, HANDLING);
    const po = `PO-${int(r, 10000, 99999)}`;
    const [cityA, cityB] = sample(r, CITIES, 2) as [string, string];
    const doc = [
      "SHIPPING NOTICE",
      `Carrier: ${carrier}`,
      `Tracking number: ${tracking}`,
      `Shipper: ${shipper}, ${cityA}`,
      `Consignee: ${consignee}, ${cityB}`,
      `Notify party: ${notify} (customs broker)`,
      `Purchase order: ${po}`,
      `Ship date: ${longDate(shipDate)}`,
      `Estimated delivery: ${longDate(eta)}`,
      `Packages: ${cartons} cartons on ${pallets} pallet${pallets === 1 ? "" : "s"}`,
      `Gross weight: ${kg.toFixed(1)} kg (${lb.toFixed(1)} lb)`,
      `Hazardous goods: ${hazardous ? "Class 3 flammable liquid (UN1263)" : "None declared"}`,
      `Handling: ${handling.text}`,
    ].join("\n");
    const request =
      "Extract this shipping notice as a JSON object with exactly these keys: tracking_number, " +
      "carrier, consignee, ship_date and estimated_delivery (both YYYY-MM-DD), packages (the " +
      "number of cartons, as an integer), weight_kg (a number), hazardous (true or false), " +
      "po_number, handling (the handling instructions, or null if none).";
    const base: Entry[] = [
      ["tracking_number", tracking],
      ["carrier", carrier],
      ["consignee", consignee],
      ["ship_date", iso(shipDate)],
      ["estimated_delivery", iso(eta)],
      ["packages", cartons],
      ["weight_kg", { raw: kg.toFixed(1) }],
      ["hazardous", hazardous],
      ["po_number", po],
      ["handling", handling.text],
    ];
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
        case "benign":
          return correct(base, v, rr);
        case "paraphrase":
          return {
            text: obj(set(base, "handling", handling.para)),
            why: "correct: handling reworded with the same meaning",
          };
        case "wrong_number":
          return {
            text: obj(set(base, "packages", pallets === cartons ? cartons + 2 : pallets)),
            why: `packages is the pallet count ${pallets}, not the ${cartons} cartons asked for`,
          };
        case "missing_requirement":
          return { text: obj(drop(base, "po_number")), why: "required key po_number is missing" };
        case "unsupported_claim": {
          const extra = pickOne(rr, EXTRA_HANDLING);
          return {
            text: obj(set(base, "handling", `${handling.text} ${extra}`)),
            why: `handling adds "${extra}", which the notice does not say`,
          };
        }
        case "wrong_entity":
          return {
            text: obj(set(base, "consignee", notify)),
            why: `consignee is the notify party ${notify}, not ${consignee}`,
          };
        case "date_off_by_one": {
          const d = offByOne(eta, rr);
          return {
            text: obj(set(base, "estimated_delivery", iso(d))),
            why: `estimated_delivery ${iso(eta)} given as ${iso(d)}`,
          };
        }
        case "unit_slip":
          return {
            text: obj(set(base, "weight_kg", { raw: lb.toFixed(1) })),
            why: `weight_kg holds the pound figure ${lb.toFixed(1)}, not ${kg.toFixed(1)} kg`,
          };
        case "format_violation":
          return {
            text: obj(
              set(set(base, "ship_date", usDate(shipDate)), "estimated_delivery", usDate(eta)),
            ),
            why: "dates written as 'Month D, YYYY' where YYYY-MM-DD was required",
          };
        case "fabricated_citation": {
          const bn = `BN-${int(rr, 1000, 9999)}`;
          return {
            text: obj(set(base, "handling", `${handling.text} See booking note ${bn}.`)),
            why: `handling cites booking note ${bn}, which the notice never mentions`,
          };
        }
        case "negation":
          return {
            text: obj(set(base, "hazardous", !hazardous)),
            why: `hazardous is ${!hazardous} but the notice says ${hazardous ? "Class 3 flammable" : "None declared"}`,
          };
      }
    };
    return { task: { request, sources: [{ name: "shipping_notice", text: doc }] }, render };
  },
};

const lease: Family = {
  id: "json.lease",
  domain: "json",
  split: "challenge",
  errors: ERROR_TYPES,
  make(r) {
    const [landlord, tenant, guarantor] = sample(r, COMPANIES, 3) as [string, string, string];
    const [agent] = people(r, 1) as [Person];
    const years = pickOne(r, [3, 5, 10]);
    const start = day(2026, int(r, 1, 12), 1);
    const end = addDays(day(start.getUTCFullYear() + years, start.getUTCMonth() + 1, 1), -1);
    const prevEnd = addDays(start, -1);
    const monthly = int(r, 18, 95) * 250;
    const annual = monthly * 12;
    const service = int(r, 2, 9) * 100;
    const depositMonths = pickOne(r, [3, 6]);
    const deposit = monthly * depositMonths;
    const breakOpt = r() < 0.5;
    const breakYear = Math.max(1, Math.floor(years / 2));
    const noticeMonths = pickOne(r, [3, 6]);
    const unit = `Unit ${int(r, 2, 40)}, ${pickOne(r, ["Riverside", "Harbour", "Mill Lane", "Station"])} Business Park, ${pickOne(r, CITIES)}`;
    const clauses = sample(r, [3, 5, 7, 9, 11, 12], 3).sort((a, b) => a - b) as [
      number,
      number,
      number,
    ];
    const letter = [
      `Dear ${agent.full},`,
      "",
      `Further to our call, we confirm the heads of terms agreed between ${landlord} (landlord) and ` +
        `${tenant} (tenant) for ${unit}. The tenant's obligations are guaranteed by ${guarantor}.`,
      "",
      `The previous lease of the unit expired on ${longDate(prevEnd)}. The new term is ${years} years ` +
        `starting on ${longDate(start)}.`,
      `Annual rent is GBP ${money(annual, 0)}, payable monthly in advance (GBP ${money(monthly, 0)} ` +
        `per month), plus a service charge of GBP ${money(service, 0)} per month (clause ${clauses[0]}).`,
      `A rent deposit equal to ${depositMonths} months' rent (GBP ${money(deposit, 0)}) is payable on completion.`,
      breakOpt
        ? `The tenant may break the lease at the end of year ${breakYear} on ${noticeMonths} months' written notice (clause ${clauses[1]}).`
        : `There is no break option; the tenant may assign with consent on ${noticeMonths} months' written notice (clause ${clauses[1]}).`,
      `Repairs are the tenant's responsibility under clause ${clauses[2]}.`,
      "",
      "Kind regards,",
      "Lettings team",
    ].join("\n");
    const noticeDays = noticeMonths === 3 ? 90 : 180;
    const request =
      "Extract the agreed lease terms as a JSON object with exactly these keys: landlord, tenant, " +
      "premises, start_date and end_date (YYYY-MM-DD; the term ends the day before the anniversary " +
      "of the start), monthly_rent (rent per month excluding service charge, a number), currency " +
      "(ISO code), deposit (a number), break_option (true or false), notice_days (the notice period " +
      "in days, taking a month as 30 days, an integer), notes (who is responsible for repairs, " +
      "citing the clause number).";
    const notes = `Repairs are the tenant's responsibility (clause ${clauses[2]}).`;
    const base: Entry[] = [
      ["landlord", landlord],
      ["tenant", tenant],
      ["premises", unit],
      ["start_date", iso(start)],
      ["end_date", iso(end)],
      ["monthly_rent", monthly],
      ["currency", "GBP"],
      ["deposit", deposit],
      ["break_option", breakOpt],
      ["notice_days", noticeDays],
      ["notes", notes],
    ];
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
        case "benign":
          return correct(base, v, rr);
        case "paraphrase":
          return {
            text: obj(
              set(
                base,
                "notes",
                `The tenant is responsible for repairs under clause ${clauses[2]}.`,
              ),
            ),
            why: "correct: notes reworded with the same meaning and clause",
          };
        case "wrong_number":
          return {
            text: obj(set(base, "monthly_rent", monthly + service)),
            why: `monthly_rent ${monthly + service} includes the service charge; rent alone is ${monthly}`,
          };
        case "missing_requirement":
          return {
            text: obj(drop(base, "notice_days")),
            why: "required key notice_days is missing",
          };
        case "unsupported_claim":
          return {
            text: obj(set(base, "notes", `${notes} Rent is reviewed every three years.`)),
            why: "notes add a three-yearly rent review the letter never mentions",
          };
        case "wrong_entity":
          return {
            text: obj(set(base, "tenant", guarantor)),
            why: `tenant is the guarantor ${guarantor}, not ${tenant}`,
          };
        case "date_off_by_one": {
          const bad = addDays(end, 1);
          return {
            text: obj(set(base, "end_date", iso(bad))),
            why: `end_date ${iso(bad)} is the anniversary; the term ends ${iso(end)}`,
          };
        }
        case "unit_slip":
          return {
            text: obj(set(base, "monthly_rent", annual)),
            why: `monthly_rent holds the annual rent ${annual}, not ${monthly} per month`,
          };
        case "format_violation":
          return {
            text: obj(set(base, "notice_days", `${noticeMonths} months`)),
            why: `notice_days given as the string "${noticeMonths} months", not an integer of days`,
          };
        case "fabricated_citation": {
          const fake = pickOne(
            rr,
            [4, 6, 8, 10, 13, 14].filter((c) => !clauses.includes(c)),
          );
          return {
            text: obj(
              set(base, "notes", `Repairs are the tenant's responsibility (clause ${fake}).`),
            ),
            why: `notes cite clause ${fake}; the letter puts repairs under clause ${clauses[2]}`,
          };
        }
        case "negation":
          return {
            text: obj(set(base, "break_option", !breakOpt)),
            why: `break_option is ${!breakOpt}, but the letter says ${breakOpt ? "the tenant may break" : "there is no break option"}`,
          };
      }
    };
    return {
      task: { request, sources: [{ name: "heads_of_terms_letter", text: letter }] },
      render,
    };
  },
};

export const jsonFamilies: readonly Family[] = [invoice, shipping, lease];
