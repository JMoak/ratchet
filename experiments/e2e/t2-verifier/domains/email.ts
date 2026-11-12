/**
 * Customer email drafts against a written policy. The application holds the policy and the case
 * record, so it computes eligibility and amounts in code (digests); the proposer drafts the reply;
 * the verifier checks the draft against the policy, the case and the request's house rules.
 */
import type { Rand } from "../../../../src/math.ts";
import type { Person } from "../pools.ts";
import {
  addDays,
  daysBetween,
  int,
  longDate,
  money,
  offByOne,
  people,
  pickOne,
  randomDate,
  round2,
} from "../pools.ts";
import { type Candidate, type Digest, ERROR_TYPES, type Family, type Variant } from "../types.ts";

const ITEMS = [
  "trail jacket",
  "hiking boots",
  "down vest",
  "rain shell",
  "wool base layer",
  "daypack",
] as const;

const REFUND_POLICY = [
  "Northwind Outfitters refund policy",
  "1. Unused items may be returned within 30 days of delivery for a refund.",
  "2. The refund covers the item price. Shipping fees are not refunded unless the item arrived damaged.",
  "3. Refunds go to the original payment method within 5 to 7 business days of the return arriving.",
].join("\n");

const refund: Family = {
  id: "email.refund",
  domain: "email",
  split: "fit",
  errors: ERROR_TYPES,
  make(r) {
    const [c] = people(r, 1) as [Person];
    const item = pickOne(r, ITEMS);
    const otherItem = pickOne(
      r,
      ITEMS.filter((i) => i !== item),
    );
    const order = `NW-${int(r, 10000, 99999)}`;
    const price = round2(int(r, 2500, 32000) / 100);
    const ship = pickOne(r, [6.5, 8.5, 12]);
    const delivered = randomDate(r, 2026);
    const eligible = r() < 0.65;
    const age = eligible ? int(r, 3, 27) : int(r, 34, 70);
    const asked = addDays(delivered, age);
    const damaged = eligible && r() < 0.4;
    const refundDue = eligible ? round2(price + (damaged ? ship : 0)) : 0;
    const caseRecord = [
      `Customer: ${c.full}`,
      `Order: ${order}`,
      `Item: ${item}, price $${money(price)}; shipping fee $${money(ship)}`,
      `Delivered: ${longDate(delivered)}`,
      `Refund request received: ${longDate(asked)}`,
      `Condition reported: ${damaged ? "arrived with a torn seam (damaged in transit)" : "unused, tags attached"}`,
    ].join("\n");
    const digests: Digest[] = [
      { name: "days_since_delivery", value: String(age) },
      { name: "within_30_day_window", value: eligible ? "yes" : "no" },
      { name: "refund_due_computed", value: `$${money(refundDue)}` },
    ];
    const request =
      "Draft the email reply to this refund request. Follow the refund policy, state the refund " +
      "amount and when it will arrive (or that no refund is possible), include the order number, " +
      "address the customer by first name, and sign off as 'Northwind Support'.";
    const compose = (o: {
      readonly name?: string;
      readonly order?: string | null;
      readonly item?: string;
      readonly date?: Date;
      readonly amount?: string;
      readonly when?: string;
      readonly elig?: boolean;
      readonly sign?: string;
      readonly ref?: string;
      readonly tail?: string;
    }): string => {
      const el = o.elig ?? eligible;
      const about = o.order === null ? "your refund request" : `order ${o.order ?? order}`;
      const lines = [`Hi ${o.name ?? c.first},`, ""];
      if (el) {
        lines.push(
          `Thank you for writing about ${about}. Your ${o.item ?? item} was delivered on ${longDate(o.date ?? delivered)}, which is within our 30-day return window${o.ref ?? ""}.` +
            ` Once the return arrives we will refund $${o.amount ?? money(refundDue)} to your original payment method within ${o.when ?? "5 to 7 business days"}.` +
            (damaged
              ? " Because it arrived damaged, this includes the shipping fee."
              : " The shipping fee is not refundable under our policy.") +
            (o.tail ?? ""),
        );
      } else {
        lines.push(
          `Thank you for writing about ${about}. Your ${o.item ?? item} was delivered on ${longDate(o.date ?? delivered)}, ${age} days before your request, which is outside our 30-day return window${o.ref ?? ""}, so we are unable to offer a refund.` +
            (o.tail ?? ""),
        );
      }
      lines.push("", o.sign ?? "Northwind Support");
      return lines.join("\n");
    };
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: `correct: ${eligible ? `refund $${money(refundDue)}` : "no refund"} per policy, order, name, sign-off`,
          };
        case "benign":
          return {
            text: plain.replace(`Hi ${c.first},`, `Hello ${c.first},`),
            why: "correct: 'Hello' instead of 'Hi'",
          };
        case "paraphrase":
          return {
            text: eligible
              ? [
                  `Hi ${c.first},`,
                  "",
                  `Thanks for getting in touch about order ${order}. Since your ${item} arrived on ${longDate(delivered)}, you are inside our 30-day return window. ` +
                    `When we receive it back, $${money(refundDue)} will be returned to the card or account you paid with, within 5 to 7 business days.` +
                    (damaged
                      ? " As it arrived damaged, the shipping fee is refunded too."
                      : " Shipping fees are not refunded under our policy."),
                  "",
                  "Northwind Support",
                ].join("\n")
              : [
                  `Hi ${c.first},`,
                  "",
                  `Thanks for getting in touch about order ${order}. Your ${item} arrived on ${longDate(delivered)}, ${age} days before you asked, and our return window is 30 days, so unfortunately a refund is not possible.`,
                  "",
                  "Northwind Support",
                ].join("\n"),
            why: "correct: reworded, same decision and facts",
          };
        case "wrong_number": {
          if (!eligible) {
            const badAge = age + pickOne(rr, [9, 11, 20]);
            return {
              text: plain.replace(`${age} days before`, `${badAge} days before`),
              why: `says ${badAge} days since delivery; it was ${age}`,
            };
          }
          const bad = damaged ? price : price + ship;
          return {
            text: compose({ amount: money(bad) }),
            why: `refund $${money(bad)}; the policy gives $${money(refundDue)}`,
          };
        }
        case "missing_requirement":
          return { text: compose({ order: null }), why: "the order number is left out" };
        case "unsupported_claim":
          return {
            text: compose({ tail: " We have also added a 10% discount code to your account." }),
            why: "promises a discount code the policy does not offer",
          };
        case "wrong_entity":
          return rr() < 0.5
            ? {
                text: compose({ item: otherItem }),
                why: `names the item as ${otherItem}; the order is a ${item}`,
              }
            : {
                text: compose({
                  name: pickOne(
                    rr,
                    ["Sam", "Alex", "Jordan"].filter((n) => n !== c.first),
                  ),
                }),
                why: `addresses the customer by the wrong name; the customer is ${c.first}`,
              };
        case "date_off_by_one": {
          const d = offByOne(delivered, rr);
          return {
            text: compose({ date: d }),
            why: `delivery date ${longDate(delivered)} given as ${longDate(d)}`,
          };
        }
        case "unit_slip":
          return eligible
            ? {
                text: compose({ when: "5 to 7 weeks" }),
                why: "timeline in weeks; the policy says 5 to 7 business days",
              }
            : {
                text: compose({}).replace(`${age} days before`, `${age} weeks before`),
                why: `says ${age} weeks; the gap is ${age} days`,
              };
        case "format_violation":
          return {
            text: compose({ sign: "Best regards,\nAlex" }),
            why: "signed 'Best regards, Alex' instead of 'Northwind Support'",
          };
        case "fabricated_citation": {
          const sec = int(rr, 5, 9);
          return {
            text: compose({ ref: ` (see section ${sec} of our policy)` }),
            why: `cites section ${sec}; the policy has sections 1 to 3`,
          };
        }
        case "negation":
          return {
            text: compose({ elig: !eligible, amount: money(price) }),
            why: eligible
              ? "refuses a refund the policy allows"
              : "grants a refund the policy does not allow",
          };
      }
    };
    return {
      task: {
        request,
        sources: [
          { name: "policy", text: REFUND_POLICY },
          { name: "case", text: caseRecord },
        ],
        digests,
      },
      render,
    };
  },
};

const PRODUCTS_AUDIO = ["over-ear headphones", "bookshelf speaker", "earbuds", "soundbar"] as const;

const WARRANTY_POLICY = [
  "Brightwave Audio warranty",
  "1. Headphones and speakers carry a 2-year warranty against manufacturing defects from the date of purchase.",
  "2. Damage from water, drops or unauthorised repair is not covered.",
  "3. For covered claims we repair or replace the product, at our choice, and pay return shipping.",
  "4. Claims need the order number and a description of the fault.",
].join("\n");

const warranty: Family = {
  id: "email.warranty",
  domain: "email",
  split: "heldout",
  errors: ERROR_TYPES,
  make(r) {
    const [c] = people(r, 1) as [Person];
    const product = pickOne(r, PRODUCTS_AUDIO);
    const other = pickOne(
      r,
      PRODUCTS_AUDIO.filter((p) => p !== product),
    );
    const order = `BW-${int(r, 100000, 999999)}`;
    const bought = randomDate(r, 2025);
    const months = int(r, 2, 22);
    const claimed = addDays(bought, months * 30 + int(r, 0, 9));
    const covered = r() < 0.6;
    const fault = covered
      ? pickOne(r, [
          "the left side stopped producing sound",
          "it no longer charges",
          "the power button stopped responding",
        ])
      : pickOne(r, [
          "it stopped working after being dropped in a pool",
          "the casing cracked after a fall onto concrete",
        ]);
    const caseRecord = [
      `Customer: ${c.full}`,
      `Order: ${order}`,
      `Product: ${product}, purchased ${longDate(bought)}`,
      `Claim received: ${longDate(claimed)}`,
      `Fault reported: ${fault}`,
    ].join("\n");
    const digests: Digest[] = [
      { name: "months_since_purchase", value: String(months) },
      { name: "within_2_year_warranty", value: "yes" },
      { name: "cause_excluded_by_policy", value: covered ? "no" : "yes" },
    ];
    const request =
      "Draft the reply to this warranty claim. Follow the warranty policy, say whether the claim is " +
      "covered and what happens next, include the order number, address the customer by first " +
      "name, and sign off as 'Brightwave Care'.";
    const compose = (o: {
      readonly name?: string;
      readonly order?: string | null;
      readonly product?: string;
      readonly date?: Date;
      readonly term?: string;
      readonly cov?: boolean;
      readonly sign?: string;
      readonly ref?: string;
      readonly ship?: string;
      readonly tail?: string;
    }): string => {
      const cov = o.cov ?? covered;
      const about = o.order === null ? "your recent purchase" : `order ${o.order ?? order}`;
      const body = cov
        ? `Thank you for your claim on ${about}. Your ${o.product ?? product}, bought on ${longDate(o.date ?? bought)}, is within the ${o.term ?? "2-year"} warranty, and the fault you describe is a covered defect${o.ref ?? ""}. ` +
          `We will repair or replace it, at our choice, and ${o.ship ?? "we pay the return shipping"}.`
        : `Thank you for your claim on ${about}. Your ${o.product ?? product}, bought on ${longDate(o.date ?? bought)}, is within the ${o.term ?? "2-year"} warranty period, but damage from water or drops is not covered${o.ref ?? ""}, so we cannot repair or replace it under warranty.`;
      return [
        `Hi ${o.name ?? c.first},`,
        "",
        body + (o.tail ?? ""),
        "",
        o.sign ?? "Brightwave Care",
      ].join("\n");
    };
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: `correct: ${covered ? "covered, repair or replace, return shipping paid" : "not covered (excluded cause)"}`,
          };
        case "benign":
          return {
            text: plain.replace(`Hi ${c.first},`, `Dear ${c.first},`),
            why: "correct: 'Dear' instead of 'Hi'",
          };
        case "paraphrase":
          return {
            text: [
              `Hi ${c.first},`,
              "",
              covered
                ? `Thanks for contacting us about order ${order}. The ${product} you bought on ${longDate(bought)} is still under its 2-year warranty and this fault is a manufacturing defect, so we will either repair or replace it (our choice) and cover the return shipping.`
                : `Thanks for contacting us about order ${order}. The ${product} you bought on ${longDate(bought)} is still inside the 2-year warranty period, but the warranty excludes damage from water or drops, so this claim is not covered.`,
              "",
              "Brightwave Care",
            ].join("\n"),
            why: "correct: reworded, same decision and facts",
          };
        case "wrong_number":
          return {
            text: compose({ term: "3-year" }),
            why: "says a 3-year warranty; the policy says 2 years",
          };
        case "missing_requirement":
          return { text: compose({ order: null }), why: "the order number is left out" };
        case "unsupported_claim":
          return {
            text: compose({
              tail: " We will also send a free carrying case with the replacement.",
            }),
            why: "promises a free carrying case the policy does not mention",
          };
        case "wrong_entity":
          return {
            text: compose({ product: other }),
            why: `names the product as ${other}; the claim is for ${product}`,
          };
        case "date_off_by_one": {
          const d = offByOne(bought, rr);
          return {
            text: compose({ date: d }),
            why: `purchase date ${longDate(bought)} given as ${longDate(d)}`,
          };
        }
        case "unit_slip":
          return {
            text: compose({ term: "2-month" }),
            why: "says a 2-month warranty; the policy says 2 years",
          };
        case "format_violation":
          return {
            text: compose({ sign: "Cheers,\nThe Brightwave team" }),
            why: "signed 'Cheers, The Brightwave team' instead of 'Brightwave Care'",
          };
        case "fabricated_citation": {
          const sec = int(rr, 6, 9);
          return {
            text: compose({ ref: ` (warranty section ${sec})` }),
            why: `cites warranty section ${sec}; the policy has sections 1 to 4`,
          };
        }
        case "negation":
          return covered
            ? {
                text: compose({ cov: true, ship: "you pay the return shipping" }),
                why: "says the customer pays return shipping; the policy says Brightwave pays",
              }
            : {
                text: compose({ cov: true }),
                why: "accepts a claim for water or drop damage, which the policy excludes",
              };
      }
    };
    return {
      task: {
        request,
        sources: [
          { name: "policy", text: WARRANTY_POLICY },
          { name: "case", text: caseRecord },
        ],
        digests,
      },
      render,
    };
  },
};

const BOOKING_POLICY = [
  "Skylark Rail change policy",
  "A. Date changes made more than 30 days before departure are free.",
  "B. Date changes made 8 to 30 days before departure cost EUR 45 per ticket.",
  "C. Date changes made 7 days or fewer before departure cost EUR 120 per ticket.",
  "D. Tickets are not transferable; the passenger name cannot be changed.",
].join("\n");

const booking: Family = {
  id: "email.booking",
  domain: "email",
  split: "challenge",
  errors: ERROR_TYPES,
  make(r) {
    const [c, friend] = people(r, 2) as [Person, Person];
    const ref = `SK${int(r, 100000, 999999)}`;
    const tickets = int(r, 1, 4);
    const departure = randomDate(r, 2026);
    const lead = pickOne(r, [int(r, 2, 7), int(r, 8, 30), int(r, 31, 60)]);
    const asked = addDays(departure, -lead);
    const newDate = addDays(departure, int(r, 2, 20));
    const perTicket = lead > 30 ? 0 : lead >= 8 ? 45 : 120;
    const fee = perTicket * tickets;
    const rule = lead > 30 ? "A" : lead >= 8 ? "B" : "C";
    const caseRecord = [
      `Booking: ${ref}, ${tickets} ticket${tickets > 1 ? "s" : ""}, passenger ${c.full}`,
      `Departure: ${longDate(departure)}`,
      `Change request received: ${longDate(asked)}`,
      `Requested new date: ${longDate(newDate)}`,
      `Note from customer: "My colleague ${friend.full} may travel instead if the date cannot move."`,
    ].join("\n");
    const digests: Digest[] = [
      { name: "days_before_departure", value: String(daysBetween(asked, departure)) },
      { name: "change_fee_computed", value: `EUR ${fee}` },
    ];
    const request =
      "Draft the reply confirming the date change. Apply the change policy, state the total change " +
      "fee, confirm the new date, answer the customer's note, include the booking reference, and " +
      "sign off as 'Skylark Rail'.";
    const compose = (o: {
      readonly ref?: string | null;
      readonly date?: Date;
      readonly fee?: string;
      readonly rule?: string;
      readonly transfer?: boolean;
      readonly cur?: string;
      readonly name?: string;
      readonly tail?: string;
    }): string =>
      [
        `Hi ${o.name ?? c.first},`,
        "",
        `Your date change for ${o.ref === null ? "your booking" : `booking ${o.ref ?? ref}`} is confirmed: you now travel on ${longDate(o.date ?? newDate)}. ` +
          `Under rule ${o.rule ?? rule} of our change policy the total change fee is ${o.fee ?? (fee === 0 ? `${o.cur ?? "EUR"} 0 (free)` : `${o.cur ?? "EUR"} ${fee}`)}. ` +
          (o.transfer
            ? `Your colleague ${friend.full} is welcome to travel on your ticket instead.`
            : "Tickets cannot be transferred, so the booking stays in your name.") +
          (o.tail ?? ""),
        "",
        "Skylark Rail",
      ].join("\n");
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: `correct: rule ${rule}, fee EUR ${fee}, new date, no transfer, reference`,
          };
        case "benign":
          return { text: plain.replace("Hi ", "Hello "), why: "correct: 'Hello' instead of 'Hi'" };
        case "paraphrase":
          return {
            text: [
              `Hi ${c.first},`,
              "",
              `We have moved booking ${ref} to ${longDate(newDate)}. The change falls under rule ${rule}, so the total fee is ${fee === 0 ? "nothing" : `EUR ${fee}`}. ` +
                "As tickets are not transferable, the passenger name must stay as it is.",
              "",
              "Skylark Rail",
            ].join("\n"),
            why: "correct: reworded, same facts",
          };
        case "wrong_number": {
          const bad =
            perTicket === 0 ? 45 * tickets : tickets > 1 ? perTicket : perTicket === 45 ? 120 : 45;
          return {
            text: compose({ fee: `EUR ${bad}` }),
            why: `fee EUR ${bad}; the policy gives EUR ${fee} for ${tickets} ticket(s) at ${lead} days`,
          };
        }
        case "missing_requirement":
          return { text: compose({ ref: null }), why: "the booking reference is left out" };
        case "unsupported_claim":
          return {
            text: compose({ tail: " Seat reservations carry over to the new train." }),
            why: "promises seat reservations carry over; the policy says nothing about seats",
          };
        case "wrong_entity":
          return {
            text: compose({ name: friend.first }),
            why: `addresses the colleague ${friend.first}; the passenger is ${c.first}`,
          };
        case "date_off_by_one": {
          const d = offByOne(newDate, rr);
          return {
            text: compose({ date: d }),
            why: `new date ${longDate(newDate)} given as ${longDate(d)}`,
          };
        }
        case "unit_slip":
          return fee === 0
            ? {
                text: compose({ tail: " Changes stay free up to 30 hours before departure." }),
                why: "says changes are free up to 30 hours before; the policy says more than 30 days",
              }
            : { text: compose({ cur: "GBP" }), why: "fee in GBP; the policy charges EUR" };
        case "format_violation":
          return {
            text: plain.replace("\nSkylark Rail", "\nKind regards,\nthe bookings desk"),
            why: "signed 'the bookings desk' instead of 'Skylark Rail'",
          };
        case "fabricated_citation":
          return { text: compose({ rule: "F" }), why: "cites rule F; the policy has rules A to D" };
        case "negation":
          return {
            text: compose({ transfer: true }),
            why: "says the colleague may travel instead; rule D forbids transfers",
          };
      }
    };
    return {
      task: {
        request,
        sources: [
          { name: "policy", text: BOOKING_POLICY },
          { name: "case", text: caseRecord },
        ],
        digests,
      },
      render,
    };
  },
};

export const emailFamilies: readonly Family[] = [refund, warranty, booking];
