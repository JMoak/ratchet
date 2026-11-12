/**
 * Track T5's corpus: new items in "the 80% regime" across five domains, each label fixed by
 * construction with a one-line reason before any model sees the item.
 *
 * Every domain is a set of families (one clause, rule set, policy or world) and each family a
 * set of variants (which facts hold). A variant fixes the label by the decider's charter: the
 * written clause, rule or policy applied exactly, numbers and dates compared in code and handed
 * to the model as a digested comparison. Entity names, numbers and phrasing are drawn from a
 * seeded generator, so every instance is a new text.
 *
 *   bun experiments/e2e/t5-compound/corpus-gen.ts pilot   -> pilot-corpus.json (fit split only)
 *   bun experiments/e2e/t5-compound/corpus-gen.ts final   -> corpus.json and spotcheck.json
 *
 * The pilot exists only to calibrate difficulty; its items are never part of the evaluation.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Rand, rng, shuffled } from "../../../src/math.ts";
import { DOMAINS, type Domain, questionText, TEAMS } from "./gates.ts";

export const HERE = fileURLToPath(new URL("./", import.meta.url));

export type Split = "pilot" | "fit" | "held";

export interface CorpusItem {
  readonly id: string;
  readonly domain: Domain;
  readonly family: string;
  readonly variant: string;
  readonly state: string;
  /** Boolean for a judge rubric; the team name for the multihop pick. */
  readonly truth: boolean | string;
  readonly why: string;
  readonly ambiguous?: true;
  /** Which wording of the rule the item used: "plain" or "negative" (same meaning). */
  readonly form?: string;
  readonly split: Split;
}

interface Drawn {
  readonly state: string;
  readonly truth: boolean | string;
  readonly why: string;
  readonly ambiguous?: true;
  readonly form?: string;
}

/**
 * A rule in two wordings with the same meaning: the plain one, and one built from negations and
 * exceptions ("need not ... unless", "no ... except"). The first pilot showed plain wordings are
 * read correctly almost always and the one "need not ... unless" clause was missed by every
 * model, so the negative wording is where readers slip. Labels never depend on the wording.
 */
type Worded = string | readonly [plain: string, negative: string];

function worded(r: Rand, w: Worded): { readonly text: string; readonly form: string } {
  if (typeof w === "string") return { text: w, form: "plain" };
  return r() < 0.5 ? { text: w[0], form: "plain" } : { text: w[1], form: "negative" };
}

interface Variant {
  readonly name: string;
  /** Relative frequency in the final corpus; set once from the pilot, then frozen. */
  readonly weight?: number;
  readonly draw: (r: Rand) => Drawn;
}

interface Family {
  readonly name: string;
  /**
   * Relative frequency of the family's variants in the final corpus, frozen after the fourth
   * pilot. Set by structure (dated facts, rule exceptions, open results), never by any
   * model's answer to a particular item.
   */
  readonly weight?: number;
  readonly variants: readonly Variant[];
}

const one = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const between = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

function listOf(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const PEOPLE = [
  "Amara Okafor",
  "Bruno Teixeira",
  "Chen Wei",
  "Dalia Haddad",
  "Elif Yilmaz",
  "Farid Nasser",
  "Greta Lindqvist",
  "Hiro Tanaka",
  "Ines Moreau",
  "Jonah Feld",
  "Kavya Rao",
  "Lena Novak",
  "Mateo Ruiz",
  "Nadia Petrova",
  "Owen Gallagher",
  "Priya Raman",
  "Quentin Blake",
  "Rosa Esposito",
  "Samir Patel",
  "Tove Berg",
];

const COMPANIES = [
  "Kestrel Logistics",
  "Orchard Health",
  "Nimbus Analytics",
  "Halvorsen Foods",
  "Quarry Lane Bank",
  "Tamsin Robotics",
  "Westmere Council",
  "Pellucid Labs",
  "Brightwater Utilities",
  "Corvid Media",
  "Juniper Freight",
  "Saltmarsh Insurance",
  "Ironbridge Clinics",
  "Larkspur Retail",
  "Meridian Schools",
  "Oakhurst Pharma",
];

// ---------------------------------------------------------------------------
// Contract obligations: is the named party required to take the named action?
// ---------------------------------------------------------------------------

interface Roles {
  readonly p: string;
  readonly c: string;
}

function contractState(
  r: Rand,
  roles: Roles,
  clause: Worded,
  situation: string,
  party: string,
  action: string,
): { readonly state: string; readonly form: string } {
  const [a, b] = shuffled(COMPANIES, r);
  const w = worded(r, clause);
  const no = `${between(r, 3, 17)}.${between(r, 1, 9)}`;
  const state = [
    `Clause ${no} of the agreement between ${a} (the "${roles.p}") and ${b} (the "${roles.c}"):`,
    `"${w.text}"`,
    "",
    `Situation: ${situation}`,
    "",
    `Party: the ${party}`,
    `Action: ${action}`,
  ].join("\n");
  return { state, form: w.form };
}

const DATA_KINDS = ["patient records", "payroll files", "customer contact list", "order history"];
const GOODS = [
  "a pallet of ceramic tiles",
  "twelve monitor arms",
  "a batch of glass vials",
  "four office chairs",
  "a crate of LED panels",
];
const SUBS = [
  "Harbourline Services",
  "Tessellate Outsourcing",
  "Northpoint Support",
  "Grayling Ops",
  "Pinecrest Solutions",
];
const EQUIPMENT = [
  "a packaging robot",
  "a commercial dishwasher",
  "a laser cutter",
  "a forklift charger",
  "an industrial chiller",
];
const MONTHS = ["February", "March", "April", "May", "June"];

function contractFamilies(): Family[] {
  const incidentRoles: Roles[] = [
    { p: "Supplier", c: "Customer" },
    { p: "Processor", c: "Controller" },
    { p: "Provider", c: "Subscriber" },
  ];
  const incidentClause = (x: Roles): Worded => [
    `The ${x.p} shall notify the ${x.c} in writing of any Security Incident affecting ${x.c} Data without undue delay and in any event within 72 hours of becoming aware of it, unless a law-enforcement authority has instructed the ${x.p} in writing to delay notification.`,
    `The ${x.p} is not required to notify the ${x.c} of a Security Incident unless it affects ${x.c} Data. Where it does, written notice is due no later than 72 hours after the ${x.p} becomes aware of it, save that no notice is due while a written instruction from a law-enforcement authority to delay notification remains in force.`,
  ];
  const incident = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, r: Rand) => string,
    clause: (x: Roles) => Worded = incidentClause,
    ambiguous = false,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, incidentRoles);
      return {
        ...contractState(
          r,
          x,
          clause(x),
          situation(x, r),
          x.p,
          `notify the ${x.c} in writing of the incident`,
        ),
        truth,
        why,
        ...(ambiguous ? { ambiguous: true as const } : {}),
      };
    },
  });

  const goodsRoles: Roles[] = [
    { p: "Supplier", c: "Customer" },
    { p: "Vendor", c: "Buyer" },
  ];
  const goodsClause = (x: Roles): Worded => [
    `If any Goods are delivered damaged, the ${x.p} shall, at the ${x.c}'s option, either replace the damaged Goods or refund the price paid for them, provided that the ${x.c} reports the damage in writing within 10 business days of delivery. This clause does not apply to damage caused by the ${x.c}'s own handling after delivery.`,
    `The ${x.p} has no obligation to replace or refund damaged Goods unless the ${x.c} reports the damage in writing within 10 business days of delivery, and in no case for damage caused by the ${x.c}'s own handling after delivery. Subject to that, it shall replace the damaged Goods or refund their price, whichever the ${x.c} elects.`,
  ];
  const goods = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, g: string, r: Rand) => string,
    role: "p" | "c" = "p",
    action = "replace the damaged goods",
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, goodsRoles);
      const g = one(r, GOODS);
      const party = role === "p" ? x.p : x.c;
      const act = action.replace("{P}", x.p);
      return {
        ...contractState(r, x, goodsClause(x), situation(x, g, r), party, act),
        truth,
        why,
      };
    },
  });

  const subRoles: Roles[] = [
    { p: "Contractor", c: "Client" },
    { p: "Supplier", c: "Customer" },
    { p: "Provider", c: "Subscriber" },
  ];
  const subClause = (x: Roles): Worded => [
    `The ${x.p} shall not subcontract any of its obligations under this Agreement without the ${x.c}'s prior written consent, except to an Affiliate of the ${x.p}, for which no consent is needed. "Affiliate" means any entity that controls, is controlled by, or is under common control with the ${x.p}.`,
    `No consent of the ${x.c} is needed for the ${x.p} to subcontract to an Affiliate. Otherwise the ${x.p} may not subcontract any of its obligations under this Agreement unless the ${x.c} has consented in writing beforehand. "Affiliate" means any entity that controls, is controlled by, or is under common control with the ${x.p}.`,
  ];
  const subcontract = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, s: string) => string,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, subRoles);
      const s = one(r, SUBS);
      return {
        ...contractState(
          r,
          x,
          subClause(x),
          situation(x, s),
          x.p,
          `obtain the ${x.c}'s prior written consent before engaging ${s}`,
        ),
        truth,
        why,
      };
    },
  });

  const auditRoles: Roles[] = [
    { p: "Processor", c: "Controller" },
    { p: "Supplier", c: "Customer" },
    { p: "Contractor", c: "Client" },
  ];
  const auditClause = (x: Roles): Worded => [
    `The ${x.c} may audit the ${x.p}'s compliance with this Agreement once in each calendar year, on at least 30 days' written notice. The ${x.p} shall give the ${x.c}'s auditors reasonable access to the relevant records for such an audit. The ${x.p} need not give access for any further audit in the same calendar year unless the previous audit found a material breach.`,
    `No audit may begin on less than 30 days' written notice, and the ${x.c} may not audit the ${x.p} more than once in a calendar year unless the previous audit found a material breach. The ${x.p} is not obliged to give auditors access to records except for an audit this clause permits; for such an audit it shall give reasonable access to the relevant records.`,
  ];
  const audit = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, r: Rand, f: Fmt) => string,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, auditRoles);
      const f = drawFormat(r, true);
      const c = contractState(
        r,
        x,
        auditClause(x),
        situation(x, r, f),
        x.p,
        `give the ${x.c}'s auditors access to the relevant records`,
      );
      return { ...c, form: `${c.form}/${f}`, truth, why };
    },
  });

  const payRoles: Roles[] = [
    { p: "Supplier", c: "Customer" },
    { p: "Contractor", c: "Client" },
    { p: "Vendor", c: "Buyer" },
  ];
  const payClause = (x: Roles): Worded => [
    `The ${x.c} shall pay each invoice within 30 days of receipt. If the ${x.c} disputes any part of an invoice in good faith, it may withhold the disputed amount until the dispute is resolved, but shall pay the undisputed remainder by the due date.`,
    `Each invoice is due 30 days after receipt. The ${x.c} may not withhold payment of any invoice or any part of one, except an amount it disputes in good faith, which it need not pay until the dispute is resolved.`,
  ];
  const amount = (r: Rand) => `$${between(r, 12, 96)},${between(r, 100, 900)}`;
  const pay = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, amt: string) => string,
    role: "p" | "c",
    action: (x: Roles) => string,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, payRoles);
      return {
        ...contractState(
          r,
          x,
          payClause(x),
          situation(x, amount(r)),
          role === "p" ? x.p : x.c,
          action(x),
        ),
        truth,
        why,
      };
    },
  });

  const delRoles: Roles[] = [
    { p: "Processor", c: "Controller" },
    { p: "Provider", c: "Subscriber" },
    { p: "Supplier", c: "Customer" },
  ];
  const delClause = (x: Roles): Worded => [
    `Within 30 days after this Agreement terminates, the ${x.p} shall delete all ${x.c} Data in its possession or control, except any copy that the ${x.p} is required by law to retain, which it shall keep confidential and delete as soon as the legal requirement ends.`,
    `Except where, and for as long as, the law requires it to retain a copy, the ${x.p} may not keep any ${x.c} Data in its possession or control later than 30 days after this Agreement terminates. A copy kept under that exception must be kept confidential.`,
  ];
  const deletion = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, r: Rand) => string,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, delRoles);
      return {
        ...contractState(
          r,
          x,
          delClause(x),
          situation(x, r),
          x.p,
          `delete the copy of ${x.c} Data described in the situation`,
        ),
        truth,
        why,
      };
    },
  });

  const warRoles: Roles[] = [
    { p: "Supplier", c: "Customer" },
    { p: "Vendor", c: "Buyer" },
  ];
  const warClause = (x: Roles): Worded => [
    `During the Warranty Period of 12 months from acceptance, the ${x.p} shall repair at its own cost any defect in the Equipment notified to it, except defects caused by misuse, by modification not authorised by the ${x.p}, or by normal wear and tear.`,
    `The ${x.p} is not responsible for any defect caused by misuse, by a modification it has not authorised, or by normal wear and tear, nor for any defect first notified after the Warranty Period of 12 months from acceptance. Any other defect in the Equipment notified to it, the ${x.p} shall repair at its own cost.`,
  ];
  const warranty = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, eq: string, r: Rand, f: Fmt) => string,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, warRoles);
      const eq = one(r, EQUIPMENT);
      const f = drawFormat(r, true);
      const c = contractState(
        r,
        x,
        warClause(x),
        situation(x, eq, r, f),
        x.p,
        "repair the defect at its own cost",
      );
      return { ...c, form: `${c.form}/${f}`, truth, why };
    },
  });

  const nsRoles: Roles[] = [
    { p: "Contractor", c: "Client" },
    { p: "Supplier", c: "Customer" },
    { p: "Provider", c: "Subscriber" },
  ];
  const nsClause: Worded = [
    "During the Term and for 12 months after it ends, neither party shall solicit for employment any employee of the other party who worked on the Services. This does not prevent either party from hiring a person who responds, without other solicitation, to a general job advertisement.",
    "Neither party may, during the Term or within 12 months after it ends, solicit for employment an employee of the other party who worked on the Services. A person who answers a general job advertisement without other solicitation is not solicited by being hired.",
  ];
  const nonSolicit = (
    name: string,
    truth: boolean,
    why: string,
    situation: (x: Roles, who: string, r: Rand, f: Fmt) => string,
    role: "p" | "c" = "p",
    action = (who: string) => `refrain from approaching ${who} about the role`,
  ): Variant => ({
    name,
    draw: (r) => {
      const x = one(r, nsRoles);
      const who = one(r, PEOPLE);
      const f = drawFormat(r, true);
      const c = contractState(
        r,
        x,
        nsClause,
        situation(x, who, r, f),
        role === "p" ? x.p : x.c,
        action(who),
      );
      return { ...c, form: `${c.form}/${f}`, truth, why };
    },
  });

  /** Written notice of an audit: digested as a day count, raw as two dates. */
  const notice = (r: Rand, f: Fmt, x: Roles, ok: boolean, january = false): string => {
    const days = ok ? near(r, [31, 32], [34, 38, 45]) : near(r, [26, 27, 28], [9, 12, 15]);
    const sent = january
      ? Date.UTC(2026, 0, between(r, 3, 9))
      : Date.UTC(2026, between(r, 2, 8), between(r, 1, 26));
    if (f === "raw") {
      return `The ${x.c} sent written notice on ${dateText(sent)} of an audit starting on ${dateText(sent + days * DAY_MS)}.`;
    }
    const when = january ? " in early January" : "";
    return `The ${x.c} sent written notice${when} of an audit starting ${days} days later (${ok ? "more" : "less"} than the 30-day minimum).`;
  };
  /** When the Equipment was accepted: digested as an age, raw as a date with today's. */
  const accepted = (r: Rand, f: Fmt, x: Roles, eq: string, inPeriod: boolean): string => {
    const [m, d] = inPeriod
      ? near(
          r,
          [
            [11, 6],
            [11, 14],
          ],
          [
            [3, 2],
            [5, 9],
            [8, 0],
          ],
        )
      : near(
          r,
          [
            [12, 12],
            [12, 20],
          ],
          [
            [14, 0],
            [16, 5],
          ],
        );
    if (f === "raw")
      return `The ${x.c} accepted ${eq} on ${dateText(monthsBefore(m, d))}; today is 12 November 2026.`;
    const ended = inPeriod ? "" : ", so the Warranty Period has ended";
    return `The ${x.c} accepted ${eq} ${m} months ${d} days ago${ended}.`;
  };
  /** The Agreement's status: in force, or ended some time ago. */
  const term = (r: Rand, f: Fmt, ended?: boolean): string => {
    if (ended === undefined) {
      if (f === "raw") {
        const start = monthsBefore(between(r, 13, 20), between(r, 0, 20));
        return `The Agreement began on ${dateText(start)} for a three-year term; today is 12 November 2026.`;
      }
      return "The Agreement is in its second year.";
    }
    const [m, d] = ended
      ? near(
          r,
          [
            [12, 12],
            [12, 22],
          ],
          [
            [15, 0],
            [19, 8],
          ],
        )
      : near(
          r,
          [
            [11, 8],
            [11, 16],
          ],
          [
            [3, 4],
            [7, 0],
            [9, 12],
          ],
        );
    if (f === "raw")
      return `The Agreement ended on ${dateText(monthsBefore(m, d))}; today is 12 November 2026.`;
    return `The Agreement ended ${m} months ${d} days ago.`;
  };

  const exfil = (x: Roles) =>
    `The ${x.p} found that ${x.c} Data had been copied out of one of its file servers by an intruder.`;

  return [
    {
      name: "C1-incident-notice",
      variants: [
        incident(
          "plain",
          true,
          "Incident affects Customer Data and no written law-enforcement instruction exists: notice required.",
          (x, r) =>
            `On ${one(r, MONTHS)} ${between(r, 2, 27)}, the ${x.p} discovered that an attacker had copied a database table holding the ${x.c}'s ${one(r, DATA_KINDS)}. No authority has contacted the ${x.p} about the incident.`,
        ),
        incident(
          "internal-only",
          false,
          "The incident touched only the party's own payroll system with no counterparty data: the duty is not triggered.",
          (x) =>
            `Ransomware encrypted the ${x.p}'s internal payroll system. The ${x.p} has confirmed that no ${x.c} Data is stored on or reachable from that system.`,
        ),
        incident(
          "law-enforcement-written",
          false,
          "A written law-enforcement instruction to delay is exactly the exception.",
          (x) =>
            `${exfil(x)} The national cybercrime unit then sent the ${x.p} a signed letter instructing it to delay notifying anyone while it investigates.`,
        ),
        incident(
          "law-enforcement-oral",
          true,
          "The exception needs a written instruction; a phone request does not excuse notice.",
          (x) =>
            `${exfil(x)} A detective from the national cybercrime unit phoned the ${x.p} and asked it to hold off on telling anyone; nothing has been sent in writing.`,
        ),
        incident(
          "subprocessor",
          true,
          "Counterparty data was affected even though a subcontractor held it; no exception applies.",
          (x) =>
            `A misconfigured storage bucket at the ${x.p}'s hosting subcontractor exposed ${x.c} Data to the internet for two days before the ${x.p} learned of it. No authority has been involved.`,
        ),
        incident(
          "discretionary",
          false,
          "This version of the clause says 'may, at its discretion': notice is optional.",
          (x, r) =>
            `On ${one(r, MONTHS)} ${between(r, 2, 27)}, the ${x.p} discovered that an attacker had copied a database table holding the ${x.c}'s ${one(r, DATA_KINDS)}. No authority has contacted the ${x.p}.`,
          (x) =>
            `Where a Security Incident affects ${x.c} Data, the ${x.p} may, at its discretion, notify the ${x.c} in writing within 72 hours of becoming aware of it.`,
        ),
        {
          ...incident(
            "past-deadline",
            true,
            "The 72-hour deadline has passed but the duty to notify is not extinguished by lateness (arguable).",
            (x) =>
              `The ${x.p} became aware 4 days ago that an intruder had read ${x.c} Data, and has not yet notified the ${x.c}. No authority has been involved.`,
            incidentClause,
            true,
          ),
          weight: 0.3,
        },
      ],
    },
    {
      name: "C2-damaged-goods",
      variants: [
        goods(
          "replace-in-time",
          true,
          "Damaged on delivery, reported in writing within 10 business days, and replacement was the option chosen.",
          (x, g) =>
            `${cap(g)} arrived cracked because the carrier's truck braked hard. The ${x.c} emailed the ${x.p} 4 business days after delivery describing the damage and asked for replacements.`,
        ),
        goods(
          "refund-chosen",
          false,
          "The counterparty chose a refund, so the duty is to refund, not to replace.",
          (x, g) =>
            `${cap(g)} arrived cracked because the carrier's truck braked hard. The ${x.c} emailed the ${x.p} 3 business days after delivery and asked for its money back for the damaged items.`,
        ),
        goods(
          "reported-late",
          false,
          "The written report came after the 10-business-day window, so the proviso is not met.",
          (x, g) =>
            `${cap(g)} arrived cracked because the carrier's truck braked hard. The ${x.c} first reported the damage in writing 13 business days after delivery and asked for replacements.`,
        ),
        goods(
          "own-handling",
          false,
          "Damage caused by the counterparty's own handling after delivery is excluded.",
          (x, g) =>
            `${cap(g)} arrived intact and were signed for without comment. Two days later the ${x.c}'s warehouse staff dropped them from a forklift. The ${x.c} reported the damage in writing the same day and asked for replacements.`,
        ),
        goods(
          "phone-only",
          false,
          "The damage was reported only by phone and the 10-business-day window for a written report has closed.",
          (x, g) =>
            `${cap(g)} arrived cracked. The ${x.c}'s receiving manager phoned the ${x.p} the next day to report it and ask for replacements, but nothing was sent in writing; 12 business days have now passed since delivery.`,
        ),
        goods(
          "wrong-party",
          false,
          "The clause places no duty on the receiving party to return anything.",
          (x, g) =>
            `${cap(g)} arrived cracked because the carrier's truck braked hard. The ${x.c} emailed the ${x.p} 4 business days after delivery describing the damage and asked for replacements.`,
          "c",
          "return the damaged goods to the {P}",
        ),
      ],
    },
    {
      name: "C3-subcontracting",
      variants: [
        subcontract(
          "unrelated-firm",
          true,
          "Subcontracting to a non-Affiliate needs prior written consent.",
          (x, s) =>
            `The ${x.p} plans to hand its overnight support desk under this Agreement to ${s}, an unrelated outsourcing firm.`,
        ),
        subcontract(
          "subsidiary",
          false,
          "A wholly owned subsidiary is an Affiliate; no consent is needed.",
          (x, s) =>
            `The ${x.p} plans to hand its overnight support desk under this Agreement to ${s}, a wholly owned subsidiary of the ${x.p}.`,
        ),
        subcontract(
          "sister-company",
          false,
          "A company under common control is an Affiliate; no consent is needed.",
          (x, s) =>
            `The ${x.p} plans to hand its overnight support desk under this Agreement to ${s}, which, like the ${x.p}, is wholly owned by the same parent company.`,
        ),
        subcontract(
          "former-affiliate",
          true,
          "Sold to an outside investor, it is no longer controlled or under common control: consent is needed.",
          (x, s) =>
            `The ${x.p} plans to hand its overnight support desk under this Agreement to ${s}, which was the ${x.p}'s subsidiary until the ${x.p} sold it to an outside investor last year.`,
        ),
        subcontract(
          "parent",
          false,
          "The parent controls the party, so it is an Affiliate; no consent is needed.",
          (x, s) =>
            `The ${x.p} plans to hand its overnight support desk under this Agreement to ${s}, the ${x.p}'s parent company, which owns all of the ${x.p}'s shares.`,
        ),
        subcontract(
          "purchase-not-subcontract",
          false,
          "Buying equipment for its own staff is not subcontracting any obligation.",
          (x, s) =>
            `The ${x.p} is buying forty laptops from ${s}, a retailer, for its own staff. No part of the services under this Agreement will be performed by ${s}.`,
        ),
      ],
    },
    {
      name: "C4-audit-access",
      weight: 2,
      variants: [
        audit(
          "first-audit",
          true,
          "First audit of the calendar year on at least 30 days' written notice: access required.",
          (x, r, f) =>
            `${notice(r, f, x, true)} It is the first audit requested this calendar year.`,
        ),
        audit(
          "second-no-breach",
          false,
          "A second audit in the same calendar year after a clean first audit need not be given access.",
          (x, r, f) =>
            `${notice(r, f, x, true)} An earlier audit took place in February of the same calendar year and found no material breach.`,
        ),
        audit(
          "second-after-breach",
          true,
          "The previous audit found a material breach, so a further audit this year must be given access.",
          (x, r, f) =>
            `${notice(r, f, x, true)} An earlier audit in February of the same calendar year found a material breach of the data-security schedule.`,
        ),
        audit(
          "short-notice",
          false,
          "Less than 30 days' notice: this is not an audit the clause provides for.",
          (x, r, f) =>
            `${notice(r, f, x, false)} It is the first audit requested this calendar year.`,
        ),
        audit(
          "new-calendar-year",
          true,
          "The earlier audit was in the previous calendar year; this is the first audit of this year.",
          (x, r, f) =>
            `${notice(r, f, x, true, true)} The previous audit was in December of the previous year and found no material breach.`,
        ),
      ],
    },
    {
      name: "C5-invoice-dispute",
      variants: [
        pay(
          "no-dispute",
          true,
          "Undisputed invoice: the paying party must pay it in full by the due date.",
          (x, amt) =>
            `The ${x.p} invoiced ${amt} for last month's services. The ${x.c} has no complaints about the invoice.`,
          "c",
          () => "pay the full invoiced amount by the due date",
        ),
        pay(
          "good-faith-dispute",
          false,
          "A good-faith dispute lets the payer withhold the disputed part, so full payment is not required.",
          (x, amt) =>
            `The ${x.c} believes, on the basis of its own delivery logs, that 15% of the hours billed on the ${amt} invoice were never worked, and has told the ${x.p} so in writing.`,
          "c",
          () => "pay the full invoiced amount by the due date",
        ),
        pay(
          "bad-faith-dispute",
          true,
          "Withholding is allowed only for a good-faith dispute; this one is admitted to be baseless.",
          (x, amt) =>
            `The ${x.c} has told the ${x.p} it disputes 15% of the ${amt} invoice. An internal email from the ${x.c}'s finance director, now disclosed, says the dispute has no basis and is only meant to delay payment.`,
          "c",
          () => "pay the full invoiced amount by the due date",
        ),
        pay(
          "undisputed-remainder",
          true,
          "The undisputed remainder must be paid by the due date.",
          (x, amt) =>
            `The ${x.c} believes, on the basis of its own delivery logs, that 15% of the hours billed on the ${amt} invoice were never worked, and has told the ${x.p} so in writing.`,
          "c",
          () => "pay the undisputed part of the invoice by the due date",
        ),
        pay(
          "wrong-party",
          false,
          "The clause imposes no credit-note duty on the invoicing party.",
          (x, amt) =>
            `The ${x.c} believes, on the basis of its own delivery logs, that 15% of the hours billed on the ${amt} invoice were never worked, and has told the ${x.p} so in writing.`,
          "p",
          (x) => `issue the ${x.c} a credit note for the disputed amount`,
        ),
      ],
    },
    {
      name: "C6-data-deletion",
      variants: [
        deletion(
          "backups",
          true,
          "After termination, data in its possession with no legal retention duty must be deleted.",
          (x, r) =>
            `The Agreement terminated ${between(r, 8, 25)} days ago. The ${x.p} still holds nightly backup tapes that contain ${x.c} Data. No law requires the ${x.p} to keep them.`,
        ),
        deletion(
          "legal-retention",
          false,
          "Copies the law requires it to retain are excepted.",
          (x, r) =>
            `The Agreement terminated ${between(r, 8, 25)} days ago. The ${x.p} holds copies of invoices containing ${x.c} Data, which tax law requires it to keep for seven years from issue; the invoices are two years old.`,
        ),
        deletion(
          "retention-ended",
          true,
          "The legal retention requirement has ended, so the copy must now be deleted.",
          (x) =>
            `The Agreement terminated 9 months ago. The ${x.p} still holds shipping records containing ${x.c} Data that customs law required it to keep for six months after termination; that period has ended.`,
        ),
        deletion(
          "not-terminated",
          false,
          "The deletion duty arises only after termination; the agreement is still running.",
          (x) =>
            `The Agreement was renewed last month and runs for another two years. The ${x.p} holds an old export of ${x.c} Data from a completed migration project.`,
        ),
        deletion(
          "analytics-copy",
          true,
          "A copy kept for its own analytics is in its possession and not legally required: delete.",
          (x, r) =>
            `The Agreement terminated ${between(r, 8, 25)} days ago. An analyst at the ${x.p} kept a spreadsheet of ${x.c} Data on a company laptop to test a forecasting model; no law requires it to be kept.`,
        ),
        deletion(
          "subcontractor-archive",
          true,
          "Data held by its subcontractor on its instructions is in its control: delete.",
          (x, r) =>
            `The Agreement terminated ${between(r, 8, 25)} days ago. ${x.c} Data is still stored in an archive run by the ${x.p}'s storage subcontractor on the ${x.p}'s instructions; no law requires it to be kept.`,
        ),
      ],
    },
    {
      name: "C7-warranty-repair",
      weight: 2,
      variants: [
        warranty(
          "manufacturing-fault",
          true,
          "A manufacturing defect notified inside the 12-month Warranty Period: repair at own cost.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, true)} It has just reported a cracked weld on the frame that the ${x.p}'s own engineer traced to a manufacturing fault.`,
        ),
        warranty(
          "warranty-expired",
          false,
          "The defect was first notified after the 12-month Warranty Period, so the duty does not apply.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, false)} It has just reported, for the first time, a manufacturing fault in the control board.`,
        ),
        warranty(
          "unauthorised-modification",
          false,
          "Caused by a modification the supplier did not authorise: excluded.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, true)} The fault appeared after the ${x.c}'s technician installed third-party firmware that the ${x.p} had not approved.`,
        ),
        warranty(
          "authorised-update",
          true,
          "The update was supplied and authorised by the supplier, so the exclusion does not apply.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, true)} The fault appeared after the ${x.c}'s technician installed a firmware update that the ${x.p} supplied and told the ${x.c} to install; the update itself contains the bug.`,
        ),
        warranty(
          "wear-and-tear",
          false,
          "Normal wear and tear is excluded.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, true)} The drive belt has worn out through ordinary daily use at the rated load.`,
        ),
        warranty(
          "misuse",
          false,
          "Use the manual forbids is misuse, which is excluded.",
          (x, eq, r, f) =>
            `${accepted(r, f, x, eq, true)} It was left running outdoors in heavy rain, which the operating manual forbids, and the control board then failed.`,
        ),
      ],
    },
    {
      name: "C8-non-solicitation",
      weight: 2,
      variants: [
        nonSolicit(
          "during-term",
          true,
          "During the Term, directly approaching a counterparty employee who worked on the Services is barred.",
          (x, who, r, f) =>
            `${term(r, f)} A recruiter at the ${x.p} wants to message ${who}, an engineer employed by the ${x.c} who has worked on the Services since launch, about a senior role.`,
        ),
        nonSolicit(
          "general-advert",
          false,
          "Hiring someone who answered a general advertisement unprompted is carved out.",
          (x, who, r, f) =>
            `${term(r, f)} ${who}, an engineer employed by the ${x.c} who worked on the Services, applied on their own to a job advertisement the ${x.p} posted on its public careers page; the ${x.p} wants to invite them to interview.`,
          "p",
          (who) => `refrain from inviting ${who} to interview`,
        ),
        nonSolicit(
          "within-tail",
          true,
          "Less than 12 months after the end is inside the tail.",
          (x, who, r, f) =>
            `${term(r, f, false)} A manager at the ${x.p} wants to call ${who}, an engineer employed by the ${x.c} who worked on the Services, to offer them a job.`,
        ),
        nonSolicit(
          "after-tail",
          false,
          "More than 12 months after the end is past the tail.",
          (x, who, r, f) =>
            `${term(r, f, true)} A manager at the ${x.p} wants to call ${who}, an engineer employed by the ${x.c} who worked on the Services, to offer them a job.`,
        ),
        nonSolicit(
          "not-on-services",
          false,
          "The restriction covers only employees who worked on the Services.",
          (x, who, r, f) =>
            `${term(r, f)} A recruiter at the ${x.p} wants to message ${who}, who works in the ${x.c}'s finance team and has never worked on the Services, about a role.`,
        ),
        nonSolicit(
          "reverse-direction",
          true,
          "'Neither party' binds the customer side as well.",
          (x, who, r, f) =>
            `${term(r, f)} The ${x.c}'s chief technology officer wants to offer a job directly to ${who}, an engineer employed by the ${x.p} who worked on the Services.`,
          "c",
        ),
      ],
    },
  ];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Numbers and dates in two formats. "digested" is what the decider's charter asks for when the
// application holds the value as data: the comparison computed in code and stated in words.
// "raw" is the same value as the requester wrote it in free text (clock times, dates, a bill
// and a head count), which the application does not hold as data. The second pilot showed
// every model near 99% on digested facts; raw values are where the arithmetic is left to the
// reader. Values are drawn near each threshold, never on it, so no label rests on whether a
// boundary is inclusive.
// ---------------------------------------------------------------------------

type Fmt = "digested" | "raw";

/** The evaluation's "today", printed wherever a raw fact needs it. */
const TODAY = Date.UTC(2026, 10, 12);
const DAY_MS = 86_400_000;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const TODAY_LINE = "Today's date: 12 November 2026";

const dateText = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const daysBefore = (n: number, from = TODAY): number => from - n * DAY_MS;
/** `months` whole months and `days` days before `from` (day of month kept at 28 or below). */
function monthsBefore(months: number, days: number, from = TODAY): number {
  const d = new Date(from);
  const day = Math.min(d.getUTCDate(), 28);
  const shifted = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, day);
  return shifted - days * DAY_MS;
}
const monthYear = (t: number): string => {
  const d = new Date(t);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** Clock time from hours after midnight, computed in whole minutes so no time reads :60. */
const clock = (hours: number): string => {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const usd = (x: number): string => `$${x.toLocaleString("en-US")}`;
/** A value from `near` 40% of the time (the band around a threshold), else from `far`. */
const near = <T>(r: Rand, close: readonly T[], far: readonly T[]): T =>
  r() < 0.4 ? one(r, close) : one(r, far);

// ---------------------------------------------------------------------------
// Eligibility under written rules.
// ---------------------------------------------------------------------------

/**
 * A rule set: its two wordings, and facts that look relevant but that no rule mentions. One
 * distractor is added to each item's facts at a random position; it never changes the label.
 */
interface RuleSet {
  readonly text: Worded;
  readonly distractors: readonly string[];
}

/** Share of items whose numeric facts are raw rather than digested. Set from the pilots. */
let RAW_SHARE = 0.5;
export function setRawShare(x: number): void {
  RAW_SHARE = x;
}

function drawFormat(r: Rand, hasNumbers: boolean): Fmt {
  return hasNumbers && r() < RAW_SHARE ? "raw" : "digested";
}

function withDistractor(
  r: Rand,
  rules: RuleSet,
  facts: readonly string[],
): { readonly text: string; readonly form: string; readonly facts: string[] } {
  const w = worded(r, rules.text);
  const out = facts.slice();
  out.splice(Math.floor(r() * (out.length + 1)), 0, one(r, rules.distractors));
  return { text: w.text, form: w.form, facts: out };
}

const plainOf = (w: Worded): string => (typeof w === "string" ? w : w[0]);

function eligibilityState(rules: string, who: string, request: string, facts: string[]): string {
  return [
    "Rules:",
    rules,
    "",
    `Applicant: ${who}`,
    `Request: ${request}`,
    "Facts:",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

const NONPROFITS = [
  "Harbour Youth Theatre",
  "Eastside Tenants' Union",
  "Green Lanes Cycling Club",
  "Millbrook Literacy Project",
  "Northfield Food Bank",
  "Stonebridge Hospice Friends",
];

type Facts = (r: Rand, f: Fmt) => string[];

interface ItemExtra {
  readonly ambiguous?: boolean;
  readonly weight?: number;
  /** The variant's facts include a number or date that has a raw form. */
  readonly numeric?: boolean;
}

function elig(
  name: string,
  truth: boolean,
  why: string,
  rules: RuleSet,
  request: (r: Rand) => string,
  facts: Facts,
  extra: ItemExtra = {},
): Variant {
  return {
    name,
    ...(extra.weight !== undefined ? { weight: extra.weight } : {}),
    draw: (r) => {
      // Grant rules are about organisations; every other rule set is about a person.
      const pool = plainOf(rules.text).includes("nonprofit organisations") ? NONPROFITS : PEOPLE;
      const who = one(r, pool);
      const req = request(r);
      const f = drawFormat(r, extra.numeric !== false);
      const d = withDistractor(r, rules, facts(r, f));
      return {
        state: eligibilityState(d.text, who, req, d.facts),
        truth,
        why,
        form: `${d.form}/${f}`,
        ...(extra.ambiguous ? { ambiguous: true as const } : {}),
      };
    },
  };
}

function eligibilityFamilies(): Family[] {
  // E1: rest and weekly hours. Raw: clock times and hours worked so far.
  const shiftRules: RuleSet = {
    text: [
      "An employee may be given an extra shift only if all of the following hold: (a) at least 11 hours of rest separate the end of their previous shift from the start of the extra shift; (b) their total hours this week, including the extra shift, do not exceed 48; (c) they are not on approved leave that day. During a declared staffing emergency, rule (a) may be waived by the employee in writing. No other rule can be waived.",
      "No employee may be given an extra shift if fewer than 11 hours of rest would separate it from the end of their previous shift, if it would take their total hours this week above 48, or on a day of approved leave. Only the rest rule can be waived, only by the employee in writing, and only during a declared staffing emergency.",
    ],
    distractors: [
      "Ward manager: has asked for this employee by name",
      "Employee's preference: keen to take the shift",
      "Extra shifts already worked this month: two",
      "Overtime budget for the ward: available",
    ],
  };
  const shiftReq = () => "an extra 8-hour shift starting Tuesday at 07:00";
  const rest = (r: Rand, f: Fmt, ok: boolean) => {
    const h = ok
      ? near(r, [11.5, 12], [12.5, 13, 13.5, 14.5])
      : near(r, [10, 10.5], [8, 8.5, 9, 9.5]);
    if (f === "raw") return `Previous shift ended: Monday at ${clock(31 - h)}`;
    return `Rest before the extra shift: ${h} hours (${ok ? "meets" : "short of"} the 11-hour minimum)`;
  };
  const hours = (r: Rand, f: Fmt, ok: boolean) => {
    const total = ok ? near(r, [46, 47], [36, 38, 40, 42, 44]) : near(r, [49, 50], [52, 54, 56]);
    if (f === "raw") return `Hours already worked this week, before the extra shift: ${total - 8}`;
    return `Hours this week including the extra shift: ${total} (${ok ? "within" : "over"} the 48-hour limit)`;
  };
  const noLeave = "Approved leave that day: none";
  const noEmerg = "Staffing emergency: none declared";
  const emerg = "Staffing emergency: declared by the hospital this morning";
  const restWaiver =
    "Written waivers on file: the employee signed a waiver of the rest requirement";
  const noWaiver = "Written waivers on file: none";

  // E2: grades and permission; nothing numeric.
  const course = "DATA 340";
  const pre = "STAT 210";
  const courseRules: RuleSet = {
    text: [
      `A student may enrol in ${course}, a 300-level course, if they have passed ${pre} with a grade of C or better, or if the course instructor has given written permission. A student on academic probation may not enrol in any 300-level course, even with permission. Credit transferred from another institution counts as passing ${pre} only once the registrar has approved the transfer.`,
      `No student on academic probation may enrol in any 300-level course. Otherwise, ${course} (a 300-level course) is closed to any student who has not passed ${pre} with a grade of C or better, unless the course instructor has given written permission. Transferred credit is not a pass in ${pre} until the registrar approves the transfer.`,
    ],
    distractors: [
      "Seats remaining in the course: 4",
      "Year of study: third year",
      "Academic advisor: suggests taking the course next year instead",
      "Overall grade point average: 3.1",
    ],
  };
  const courseReq = () => `enrolment in ${course}`;
  const enrol = (
    name: string,
    truth: boolean,
    why: string,
    facts: string[],
    extra: ItemExtra = {},
  ) => elig(name, truth, why, courseRules, courseReq, () => facts, { numeric: false, ...extra });

  // E3: segment duration. Raw: departure and arrival times in one time zone.
  const flightRules: RuleSet = {
    text: [
      "Business-class airfare is reimbursed only when the scheduled flight time of the business-class segment exceeds 6 hours, or when the traveller has a medical accommodation on file with HR. In every case the ticket must be booked through the company travel portal; tickets booked anywhere else are reimbursed at most at the economy fare.",
      "Business-class fares are not reimbursed unless the business-class segment is scheduled for more than 6 hours or the traveller has a medical accommodation on file with HR, and never for a ticket booked outside the company travel portal (such tickets are reimbursed at the economy fare at most).",
    ],
    distractors: [
      "Fare difference over economy: $1,240",
      "Trip approved by the traveller's manager: yes",
      "Traveller's seniority: vice president",
      "Airline loyalty status: gold",
    ],
  };
  const flightReq = () => "reimbursement of a business-class fare";
  const segment = (r: Rand, f: Fmt, long: boolean) => {
    const mins = long
      ? near(r, [370, 385, 395], [430, 480, 545, 610])
      : near(r, [330, 345, 350], [150, 200, 255, 290]);
    if (f === "raw") {
      const dep = one(r, [7.25, 8.5, 9.75, 10.5]);
      return `Business-class segment: departs ${clock(dep)}, arrives ${clock(dep + mins / 60)} the same day, both times in the same time zone`;
    }
    const hm = `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
    return `Scheduled flight time of the business-class segment: ${hm} (${long ? "over" : "not over"} 6 hours)`;
  };

  // E4: time operating. Raw: the month the organisation started, and today's date.
  const grantRules: RuleSet = {
    text: [
      "Applicants must be registered nonprofit organisations that have operated in the county for at least two years. An organisation that received a grant in the previous funding cycle is not eligible unless it has submitted its final report for that grant. Fiscally sponsored projects must apply through their sponsor and may not apply in their own name.",
      "No organisation is eligible unless it is a registered nonprofit that has operated in the county for at least two years. A recipient of a grant in the previous funding cycle is ineligible until it has submitted that grant's final report. A fiscally sponsored project may not apply in its own name, only through its sponsor.",
    ],
    distractors: [
      "Annual budget: $340,000",
      "Active volunteers: 45",
      "Earlier applications: one rejected in 2023",
      "Board chair: a former county councillor",
    ],
  };
  const grantReq = () => "a community grant in the current funding cycle";
  const operating = (r: Rand, f: Fmt, ok: boolean): string[] => {
    const months = ok ? near(r, [26, 27], [36, 48, 60, 80]) : near(r, [21, 22], [13, 15, 18]);
    if (f === "raw")
      return [`Operating in the county since: ${monthYear(monthsBefore(months, 0))}`, TODAY_LINE];
    const span =
      months >= 24 ? `${Math.floor(months / 12)} years ${months % 12} months` : `${months} months`;
    return [
      `Operating in the county for: ${span} (${ok ? "meets" : "short of"} the two-year minimum)`,
    ];
  };

  // E5: continuous service. Raw: start date and expected birth date.
  const leaveRules: RuleSet = {
    text: [
      "Employees with at least 6 months of continuous service on the expected birth or placement date are entitled to 16 weeks of paid parental leave. Service with a company we acquired counts toward continuous service if the employee transferred to us without a break. Contractors are not employees for this policy.",
      "No employee is entitled to the 16 weeks of paid parental leave with less than 6 months of continuous service on the expected birth or placement date. Service with a company we acquired counts toward continuous service only if the employee transferred to us without a break. Contractors are not employees for this policy.",
    ],
    distractors: [
      "Department: finance",
      "Manager: supports the leave",
      "Performance rating last year: meets expectations",
      "Planned return date: confirmed with the team",
    ],
  };
  const leaveReq = () => "16 weeks of paid parental leave";
  const BIRTH = TODAY + 45 * DAY_MS;
  const service = (r: Rand, f: Fmt, ok: boolean, label = "Joined us as an employee"): string => {
    const [m, d] = ok
      ? near(
          r,
          [
            [6, 9],
            [6, 14],
          ],
          [
            [8, 3],
            [11, 0],
            [19, 6],
            [30, 2],
          ],
        )
      : near(
          r,
          [
            [5, 12],
            [5, 18],
          ],
          [
            [2, 4],
            [3, 10],
            [4, 1],
          ],
        );
    const start = monthsBefore(m, d, BIRTH);
    if (f === "raw") return `${label}: ${dateText(start)}; expected birth date: ${dateText(BIRTH)}`;
    return `Continuous service with us on the expected birth date: ${m} months ${d} days (${ok ? "meets" : "short of"} the 6-month minimum)`;
  };

  // E6: income and guarantor multiples, eviction age. Raw: dollars and the judgment's month.
  const rentRules: RuleSet = {
    text: [
      "Approve the application if the applicant's verified monthly income is at least three times the monthly rent, or if a guarantor with verified income of at least five times the rent has co-signed the lease. Do not approve any applicant with an eviction judgment in the past three years, unless a court has sealed that record.",
      "Do not approve an application unless the applicant's verified monthly income is at least three times the monthly rent or a guarantor with verified income of at least five times the rent has co-signed the lease, and never approve an applicant with an eviction judgment in the past three years that a court has not sealed.",
    ],
    distractors: [
      "Credit score: 690",
      "Pets: one cat",
      "Reference from current landlord: positive",
      "Requested move-in: next month",
    ],
  };
  const rentReq = () => "approval of a lease application";
  const money = (r: Rand, f: Fmt, who: "applicant" | "guarantor", ok: boolean, rent: number) => {
    const need = who === "applicant" ? 3 : 5;
    const ratio = ok
      ? near(r, [need + 0.08, need + 0.15], [need + 0.6, need + 1.3])
      : near(r, [need - 0.1, need - 0.06], [need - 0.9, need - 0.5]);
    const income = Math.round((ratio * rent) / 10) * 10;
    if (income >= need * rent !== ok) throw new Error("rent ratio drawn on the wrong side");
    const subject =
      who === "applicant" ? "Verified monthly income" : "Guarantor's verified monthly income";
    if (f === "raw") return `${subject}: ${usd(income)}`;
    const times = (income / rent).toFixed(2);
    return `${subject}: ${times} times the monthly rent (${ok ? "meets" : "below"} the ${need === 3 ? "three" : "five"}-times requirement)`;
  };
  const rentLine = (f: Fmt, rent: number) => (f === "raw" ? [`Monthly rent: ${usd(rent)}`] : []);
  const eviction = (r: Rand, f: Fmt, recent: boolean, sealed = false): string[] => {
    const months = recent ? near(r, [31, 33], [8, 14, 20, 26]) : near(r, [39, 41], [50, 62, 80]);
    const tail = sealed ? "; a court sealed the record last year" : "";
    if (f === "raw")
      return [
        `Eviction judgments: one, entered in ${monthYear(monthsBefore(months, 0))}${tail}`,
        TODAY_LINE,
      ];
    const span = `${Math.floor(months / 12)} years ${months % 12} months ago`;
    return [
      `Eviction judgments: one, ${span} (${recent ? "within" : "more than"} three years)${tail}`,
    ];
  };
  const rentOf = (r: Rand) => between(r, 120, 240) * 10;

  return [
    {
      name: "E1-extra-shift",
      variants: [
        elig(
          "all-met",
          true,
          "Rest, hours and leave rules all met.",
          shiftRules,
          shiftReq,
          (r, f) => [rest(r, f, true), hours(r, f, true), noLeave, noEmerg, noWaiver],
        ),
        elig(
          "short-rest",
          false,
          "Fewer than 11 hours of rest and no waiver.",
          shiftRules,
          shiftReq,
          (r, f) => [rest(r, f, false), hours(r, f, true), noLeave, noEmerg, noWaiver],
        ),
        elig(
          "waiver-without-emergency",
          false,
          "The rest rule can be waived only during a declared emergency; none is declared.",
          shiftRules,
          shiftReq,
          (r, f) => [rest(r, f, false), hours(r, f, true), noLeave, noEmerg, restWaiver],
        ),
        elig(
          "waiver-in-emergency",
          true,
          "Short rest is waived in writing during a declared emergency; other rules met.",
          shiftRules,
          shiftReq,
          (r, f) => [rest(r, f, false), hours(r, f, true), noLeave, emerg, restWaiver],
        ),
        elig(
          "hours-over",
          false,
          "The shift would take the week above 48 hours, which cannot be waived.",
          shiftRules,
          shiftReq,
          (r, f) => [
            rest(r, f, true),
            hours(r, f, false),
            noLeave,
            emerg,
            'Written waivers on file: the employee signed a waiver of "all scheduling limits"',
          ],
        ),
        elig(
          "on-leave",
          false,
          "The employee is on approved leave that day.",
          shiftRules,
          shiftReq,
          (r, f) => [
            rest(r, f, true),
            hours(r, f, true),
            "Approved leave that day: yes, a half day of annual leave",
            noEmerg,
            noWaiver,
          ],
        ),
      ],
    },
    {
      name: "E2-course-enrolment",
      variants: [
        enrol("grade-met", true, "Passed the prerequisite with B-, not on probation.", [
          `${pre}: passed with a B- (meets the C-or-better requirement)`,
          "Instructor permission: none",
          "Academic probation: no",
        ]),
        enrol(
          "low-grade-written-permission",
          true,
          "Grade too low, but written instructor permission is an alternative route.",
          [
            `${pre}: passed with a D+ (below the C requirement)`,
            "Instructor permission: written permission emailed by the instructor",
            "Academic probation: no",
          ],
        ),
        enrol(
          "low-grade-verbal-permission",
          false,
          "Permission must be written; a spoken okay does not count.",
          [
            `${pre}: passed with a D+ (below the C requirement)`,
            "Instructor permission: the instructor said in office hours that the student could join, but has not put it in writing",
            "Academic probation: no",
          ],
        ),
        enrol("probation", false, "Students on probation may not enrol in any 300-level course.", [
          `${pre}: passed with a B (meets the C-or-better requirement)`,
          "Instructor permission: written permission emailed by the instructor",
          "Academic probation: yes, since last term",
        ]),
        enrol(
          "transfer-approved",
          true,
          "Approved transfer credit counts as passing the prerequisite.",
          [
            `${pre}: not taken here; an equivalent course from Lakeside College was transferred and the registrar approved the transfer`,
            "Instructor permission: none",
            "Academic probation: no",
          ],
        ),
        enrol(
          "transfer-pending",
          false,
          "Transfer credit counts only once approved; it is still pending.",
          [
            `${pre}: not taken here; an equivalent course from Lakeside College was submitted for transfer and is awaiting the registrar's approval`,
            "Instructor permission: none",
            "Academic probation: no",
          ],
        ),
        enrol(
          "text-message-permission",
          true,
          "A text message from the instructor is arguably written permission (ambiguous).",
          [
            `${pre}: passed with a D (below the C requirement)`,
            "Instructor permission: a text message from the instructor saying 'fine by me, join the class'",
            "Academic probation: no",
          ],
          { ambiguous: true, weight: 0.3 },
        ),
      ],
    },
    {
      name: "E3-business-class",
      variants: [
        elig(
          "long-portal",
          true,
          "Segment over 6 hours and booked through the portal.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, true),
            "Medical accommodation on file with HR: none",
            "Booked through: the company travel portal",
          ],
        ),
        elig(
          "medical-portal",
          true,
          "Short segment, but a medical accommodation is on file and it was booked via the portal.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, false),
            "Medical accommodation on file with HR: yes, on file since 2024",
            "Booked through: the company travel portal",
          ],
        ),
        elig(
          "long-booked-elsewhere",
          false,
          "Long segment, but booked outside the portal, so business class is not reimbursed.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, true),
            "Medical accommodation on file with HR: none",
            "Booked through: the airline's own website",
          ],
        ),
        elig(
          "short-no-medical",
          false,
          "Segment not over 6 hours and no medical accommodation.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, false),
            "Medical accommodation on file with HR: none",
            "Booked through: the company travel portal",
          ],
        ),
        elig(
          "long-journey-short-segment",
          false,
          "The rule counts the business-class segment, which is short; total journey time is irrelevant.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, false),
            `Total journey time including a connection flown in economy: ${between(r, 9, 12)} h ${between(r, 10, 50)} min`,
            "Medical accommodation on file with HR: none",
            "Booked through: the company travel portal",
          ],
        ),
        elig(
          "medical-not-filed",
          false,
          "The medical accommodation must be on file with HR; a note held by the manager is not.",
          flightRules,
          flightReq,
          (r, f) => [
            segment(r, f, false),
            "Medical accommodation on file with HR: none; the traveller's manager holds a doctor's note that has not been filed with HR",
            "Booked through: the company travel portal",
          ],
        ),
      ],
    },
    {
      name: "E4-community-grant",
      variants: [
        elig(
          "eligible",
          true,
          "Nonprofit, two years or more in the county, no prior grant.",
          grantRules,
          grantReq,
          (r, f) => [
            "Registered as: a nonprofit organisation",
            ...operating(r, f, true),
            "Grant in the previous cycle: none",
            "Fiscal sponsorship: none",
          ],
        ),
        elig(
          "too-young",
          false,
          "Operating in the county for less than two years.",
          grantRules,
          grantReq,
          (r, f) => [
            "Registered as: a nonprofit organisation",
            ...operating(r, f, false),
            "Grant in the previous cycle: none",
            "Fiscal sponsorship: none",
          ],
        ),
        elig(
          "prior-grant-reported",
          true,
          "A prior grant is fine once its final report is submitted.",
          grantRules,
          grantReq,
          (r, f) => [
            "Registered as: a nonprofit organisation",
            ...operating(r, f, true),
            "Grant in the previous cycle: yes; final report submitted in March",
            "Fiscal sponsorship: none",
          ],
        ),
        elig(
          "prior-grant-unreported",
          false,
          "Prior grant with no final report submitted.",
          grantRules,
          grantReq,
          (r, f) => [
            "Registered as: a nonprofit organisation",
            ...operating(r, f, true),
            "Grant in the previous cycle: yes; final report not yet submitted",
            "Fiscal sponsorship: none",
          ],
        ),
        elig(
          "sponsored-own-name",
          false,
          "A fiscally sponsored project may not apply in its own name.",
          grantRules,
          grantReq,
          (r, f) => [
            "Registered as: a nonprofit organisation",
            ...operating(r, f, true),
            "Grant in the previous cycle: none",
            "Fiscal sponsorship: the project is fiscally sponsored by the Riverbend Community Trust and is applying in its own name",
          ],
        ),
        elig("company", false, "Not a registered nonprofit.", grantRules, grantReq, (r, f) => [
          "Registered as: a limited company (not a nonprofit)",
          ...operating(r, f, true),
          "Grant in the previous cycle: none",
          "Fiscal sponsorship: none",
        ]),
      ],
    },
    {
      name: "E5-parental-leave",
      variants: [
        elig(
          "enough-service",
          true,
          "Employee with 6 months or more of continuous service.",
          leaveRules,
          leaveReq,
          (r, f) => ["Status: employee", service(r, f, true)],
        ),
        elig(
          "short-service",
          false,
          "Less than 6 months of continuous service.",
          leaveRules,
          leaveReq,
          (r, f) => ["Status: employee", service(r, f, false)],
        ),
        elig(
          "acquired-no-break",
          true,
          "Acquired-company service counts after a transfer without a break.",
          leaveRules,
          leaveReq,
          (r, f) => [
            "Status: employee",
            service(r, f, false, "Joined us directly as an employee"),
            "Before that: 2 years at Brightwave, a company we acquired; transferred to us without a break",
          ],
        ),
        elig(
          "acquired-with-gap",
          false,
          "A gap between the acquired company and us breaks continuity.",
          leaveRules,
          leaveReq,
          (r, f) => [
            "Status: employee",
            service(r, f, false, "Joined us directly as an employee"),
            "Before that: 2 years at Brightwave, a company we acquired; left Brightwave and joined us after a 5-week gap",
          ],
        ),
        elig(
          "contractor",
          false,
          "Contractors are not employees for this policy.",
          leaveRules,
          leaveReq,
          (r) => [
            "Status: contractor",
            `Engaged by us on the expected birth date for: ${between(r, 12, 30)} months`,
          ],
          { numeric: false },
        ),
        elig(
          "converted-contractor",
          true,
          "Now an employee with 6 months or more of service as an employee.",
          leaveRules,
          leaveReq,
          (r, f) => [
            "Status: employee",
            service(r, f, true, "Became an employee"),
            "Before that: a contractor with us for one year",
          ],
        ),
      ],
    },
    {
      name: "E6-lease-application",
      variants: [
        elig(
          "income-met",
          true,
          "Income at least three times rent; no eviction.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", true, rent),
              "Guarantor: none",
              "Eviction judgments: none",
            ];
          },
        ),
        elig(
          "income-low",
          false,
          "Income below three times rent and no guarantor.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", false, rent),
              "Guarantor: none",
              "Eviction judgments: none",
            ];
          },
        ),
        elig(
          "guarantor-signed",
          true,
          "Low income, but a qualifying guarantor has co-signed.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", false, rent),
              `${money(r, f, "guarantor", true, rent)}; has co-signed the lease`,
              "Eviction judgments: none",
            ];
          },
        ),
        elig(
          "guarantor-short",
          false,
          "Low income, and the co-signing guarantor earns less than five times rent.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", false, rent),
              `${money(r, f, "guarantor", false, rent)}; has co-signed the lease`,
              "Eviction judgments: none",
            ];
          },
        ),
        elig(
          "recent-eviction",
          false,
          "An unsealed eviction within three years.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", true, rent),
              "Guarantor: none",
              ...eviction(r, f, true),
            ];
          },
        ),
        elig(
          "sealed-eviction",
          true,
          "The recent eviction record was sealed by a court.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", true, rent),
              "Guarantor: none",
              ...eviction(r, f, true, true),
            ];
          },
        ),
        elig(
          "old-eviction",
          true,
          "The eviction is older than three years.",
          rentRules,
          rentReq,
          (r, f) => {
            const rent = rentOf(r);
            return [
              ...rentLine(f, rent),
              money(r, f, "applicant", true, rent),
              "Guarantor: none",
              ...eviction(r, f, false),
            ];
          },
        ),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Policy compliance: does the request comply with the written policy?
// ---------------------------------------------------------------------------

function policyState(policy: string, request: string, facts: string[]): string {
  return [
    "Policy:",
    policy,
    "",
    `Request: ${request}`,
    "Facts:",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

type PolicyFacts = (r: Rand, f: Fmt, who: string) => string[];

function pol(
  name: string,
  truth: boolean,
  why: string,
  policy: RuleSet,
  request: (r: Rand, who: string) => string,
  facts: PolicyFacts,
  extra: ItemExtra = {},
): Variant {
  return {
    name,
    ...(extra.weight !== undefined ? { weight: extra.weight } : {}),
    draw: (r) => {
      // The requester is drawn once, and every other person named is someone else, so no
      // item reads as the requester approving or sponsoring their own request.
      const who = one(r, PEOPLE);
      const req = request(r, who);
      const f = drawFormat(r, extra.numeric !== false);
      const d = withDistractor(r, policy, facts(r, f, who));
      return {
        state: policyState(d.text, req, d.facts),
        truth,
        why,
        form: `${d.form}/${f}`,
        ...(extra.ambiguous ? { ambiguous: true as const } : {}),
      };
    },
  };
}

const notWho = (r: Rand, who: string): string =>
  one(
    r,
    PEOPLE.filter((x) => x !== who),
  );

const CITIES = ["Denver", "Lyon", "Osaka", "Leeds", "Monterrey", "Gdansk"];

function policyFamilies(): Family[] {
  // P1: per-person amount. Raw: the bill and the number of people at the table.
  const expense: RuleSet = {
    text: [
      "Meals are reimbursed up to $75 per person per day when the employee is travelling overnight on company business. Alcohol is never reimbursed. A meal with clients is exempt from the daily limit if a director approved it in advance. Every claim needs an itemised receipt.",
      "No meal is reimbursed unless the employee was travelling overnight on company business, and no claim is paid without an itemised receipt. Alcohol is not reimbursed in any case. No meal may exceed $75 per person per day, except a meal with clients that a director approved in advance.",
    ],
    distractors: [
      "Line manager's sign-off on the claim: given",
      "Submitted: 3 days after the trip",
      "Cost centre: sales",
      "Paid with: corporate card",
    ],
  };
  const meal = (_r: Rand, who: string) =>
    `${who} claims reimbursement for a dinner, the only meal claimed that day`;
  const overnight = (r: Rand) => `Overnight business travel: yes (two nights in ${one(r, CITIES)})`;
  const amount = (r: Rand, f: Fmt, ok: boolean) => {
    const per = ok
      ? near(r, [72, 73, 74], [41, 48, 55, 62, 68])
      : near(r, [76, 77, 78], [96, 110, 128, 160]);
    const people = between(r, 2, 5);
    if (f === "raw")
      return `Bill: ${usd(per * people)} for ${people} people, no tip, no other items`;
    return `Amount per person: $${per} (${ok ? "within" : "over"} the $75 daily limit)`;
  };
  const clientMeal = (r: Rand) => `Client meal: yes, with guests from ${one(r, COMPANIES)}`;
  const director = (r: Rand, who: string) => `${notWho(r, who)}, a director`;

  // P2: days since the call. Raw: the call date and today's date.
  const retention: RuleSet = {
    text: [
      "Recordings of customer support calls must be deleted 90 days after the call. A recording covered by a legal hold issued by the Legal department must be kept until Legal releases the hold, even beyond 90 days. No other team may extend retention.",
      "No recording of a customer support call may be kept more than 90 days after the call, unless the Legal department has issued a legal hold on it, in which case it may not be deleted until Legal releases the hold. No team other than Legal can extend retention.",
    ],
    distractors: [
      "Call topic: billing dispute",
      "Customer satisfaction score for the call: 2 of 5",
      "Storage cost of the recording: negligible",
      "The requesting team's director supports the request",
    ],
  };
  const callAge = (r: Rand, f: Fmt, past: boolean): string[] => {
    const days = past
      ? near(r, [93, 95, 97], [110, 130, 160, 200])
      : near(r, [83, 85, 87], [11, 25, 40, 60]);
    if (f === "raw") return [`Date of the call: ${dateText(daysBefore(days))}`, TODAY_LINE];
    return [`Days since the call: ${days} (${past ? "past" : "within"} the 90-day limit)`];
  };
  const keepReq = (team: string, why: string) => () =>
    `The ${team} team asks to keep a support call recording ${why}`;
  const delReq = () => () => "The support team asks to delete a support call recording";

  // P3: grant duration. Raw: the window as clock times.
  const access: RuleSet = {
    text: [
      "Write access to the production database may be granted only to (a) engineers in the current on-call rotation or (b) engineers with an approved change ticket for the work. Contractors also need a named employee sponsor. Every grant must expire within 8 hours.",
      "Production database write access may not be granted except to engineers in the current on-call rotation or with an approved change ticket for the work, and never to a contractor without a named employee sponsor. No grant may last longer than 8 hours.",
    ],
    distractors: [
      "Team: payments",
      "Production access grants to this requester this month: one",
      "Laptop compliance check: passed",
      "Line manager's approval: given",
    ],
  };
  const accessReq = (_r: Rand, who: string) =>
    `${who} requests write access to the production database`;
  const window = (r: Rand, f: Fmt, ok: boolean) => {
    const hours = ok ? near(r, [7, 7.5], [2, 3, 4, 5.5]) : near(r, [8.5, 9], [10, 11.5, 12]);
    const start = one(r, [8, 8.5, 9, 9.5, 10]);
    if (f === "raw")
      return `Requested access window: today from ${clock(start)} to ${clock(start + hours)}`;
    return `Requested duration: ${hours} hours (${ok ? "within" : "longer than"} the 8-hour maximum)`;
  };

  // P4: days since delivery. Raw: the delivery date and today's date.
  const refunds: RuleSet = {
    text: [
      "Items may be returned within 30 days of delivery for a full refund to the original payment method if unopened. Opened items are refundable only if defective. Items marked final sale cannot be returned. Gifts are refunded as store credit only.",
      "No item is refundable more than 30 days after delivery. An opened item is not refundable unless it is defective, a final-sale item cannot be returned at all, and a gift is never refunded to a payment method, only as store credit. Otherwise an unopened item may be returned for a full refund to the original payment method.",
    ],
    distractors: [
      "Original price: $89",
      "Customer account age: 4 years",
      "Customer loyalty tier: gold",
      "Return label: already printed by the customer",
    ],
  };
  const ITEMS = [
    "a blender",
    "a pair of headphones",
    "a desk lamp",
    "a coffee grinder",
    "a smart thermostat",
  ];
  const cardRefund = (r: Rand) =>
    `A customer asks for a full refund to their card for ${one(r, ITEMS)}`;
  const delivered = (r: Rand, f: Fmt, inTime: boolean): string[] => {
    const days = inTime
      ? near(r, [26, 27, 28], [4, 9, 15, 21])
      : near(r, [32, 33, 34], [41, 50, 60]);
    if (f === "raw") return [`Delivered: ${dateText(daysBefore(days))}`, TODAY_LINE];
    return [`Days since delivery: ${days} (${inTime ? "within" : "past"} 30 days)`];
  };

  // P5: approvals; nothing numeric.
  const merge: RuleSet = {
    text: [
      "A change may be merged to main only with two approvals from people other than its author, at least one of whom is a code owner of the changed files. During an open incident, a hotfix may be merged with a single approval if that approver is a code owner. An author's approval of their own change never counts.",
      "No change may be merged to main without two approvals from people other than its author, at least one of them a code owner of the changed files, except that during an open incident a hotfix needs only one approval, provided it is from a code owner. An author's approval of their own change does not count.",
    ],
    distractors: [
      "Continuous integration: all checks passing",
      "Lines changed: 42",
      "Release freeze: not in effect",
      "Reviewer comments: all resolved",
    ],
  };
  const mergeReq = (r: Rand, who: string) =>
    `${who} wants to merge pull request #${between(r, 1200, 9800)} to main`;
  const others = (r: Rand, who: string) =>
    shuffled(
      PEOPLE.filter((x) => x !== who),
      r,
    );
  const prMerge = (name: string, truth: boolean, why: string, facts: PolicyFacts) =>
    pol(name, truth, why, merge, mergeReq, facts, { numeric: false });

  // P6: review age. Raw: the month of the review and today's date.
  const vendor: RuleSet = {
    text: [
      "A vendor that will process personal data may be onboarded only after (1) a data processing agreement is signed and (2) a security review has been completed within the last 12 months. A vendor that will not process personal data needs only a signed master agreement.",
      "No vendor that will process personal data may be onboarded until a data processing agreement is signed and a security review has been completed within the last 12 months. A vendor that will not process personal data needs nothing more than a signed master agreement.",
    ],
    distractors: [
      "Contract value: $48,000 per year",
      "Business sponsor: head of marketing",
      "Vendor's own ISO 27001 certificate: current",
      "Reference checks: completed",
    ],
  };
  const vendorReq = (r: Rand) => `Procurement asks to onboard ${one(r, SUBS)} as a vendor`;
  const review = (r: Rand, f: Fmt, recent: boolean): string[] => {
    const [m, d] = recent
      ? near(
          r,
          [
            [10, 20],
            [11, 5],
          ],
          [
            [2, 3],
            [4, 10],
            [7, 0],
          ],
        )
      : near(
          r,
          [
            [12, 20],
            [13, 4],
          ],
          [
            [15, 0],
            [20, 6],
            [26, 1],
          ],
        );
    if (f === "raw")
      return [`Security review: completed ${dateText(monthsBefore(m, d))}`, TODAY_LINE];
    return [
      `Security review: completed ${m} months ${d} days ago (${recent ? "within" : "older than"} the last 12 months)`,
    ];
  };
  const pd = "Will process personal data: yes, customer names and email addresses";

  return [
    {
      name: "P1-meal-expense",
      variants: [
        pol(
          "within-limit",
          true,
          "Overnight, within the limit, receipt, no alcohol.",
          expense,
          meal,
          (r, f) => [
            overnight(r),
            amount(r, f, true),
            "Client meal: no",
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "over-limit",
          false,
          "Over the per-person limit and not a pre-approved client meal.",
          expense,
          meal,
          (r, f) => [
            overnight(r),
            amount(r, f, false),
            "Client meal: no",
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "client-director-advance",
          true,
          "Client meal approved in advance by a director is exempt from the limit.",
          expense,
          meal,
          (r, f, who) => [
            overnight(r),
            amount(r, f, false),
            clientMeal(r),
            `Approval: approved in advance by ${director(r, who)}`,
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "client-manager-approval",
          false,
          "Approval came from a senior manager, not a director, so the limit still applies.",
          expense,
          meal,
          (r, f, who) => [
            overnight(r),
            amount(r, f, false),
            clientMeal(r),
            `Approval: approved in advance by ${notWho(r, who)}, a senior manager`,
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "client-approved-after",
          false,
          "The director approved after the meal, not in advance.",
          expense,
          meal,
          (r, f, who) => [
            overnight(r),
            amount(r, f, false),
            clientMeal(r),
            `Approval: approved by ${director(r, who)} the morning after the dinner`,
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "alcohol",
          false,
          "The claim includes alcohol, which is never reimbursed.",
          expense,
          meal,
          (r, f) => [
            overnight(r),
            amount(r, f, true),
            "Client meal: no",
            `Alcohol on the receipt: one bottle of wine ($${between(r, 28, 45)}), included in the claim`,
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "day-trip",
          false,
          "Meals are reimbursed only on overnight travel.",
          expense,
          meal,
          (r, f) => [
            `Overnight business travel: no; a same-day trip to ${one(r, CITIES)}`,
            amount(r, f, true),
            "Client meal: no",
            "Alcohol on the receipt: none",
            "Itemised receipt: attached",
          ],
        ),
        pol(
          "photo-of-receipt",
          true,
          "A clear photo of an itemised receipt is arguably an itemised receipt (ambiguous).",
          expense,
          meal,
          (r, f) => [
            overnight(r),
            amount(r, f, true),
            "Client meal: no",
            "Alcohol on the receipt: none",
            "Itemised receipt: the paper original was lost; a clear photo of the itemised receipt is attached",
          ],
          { ambiguous: true, weight: 0.3 },
        ),
      ],
    },
    {
      name: "P2-recording-retention",
      variants: [
        pol(
          "keep-old-no-hold",
          false,
          "Past 90 days with no Legal hold: it must be deleted, not kept.",
          retention,
          keepReq("training", "for new-agent training"),
          (r, f) => [...callAge(r, f, true), "Legal hold: none"],
        ),
        pol(
          "keep-under-legal-hold",
          true,
          "A Legal-issued hold requires keeping it past 90 days.",
          retention,
          keepReq("legal", "under its hold"),
          (r, f) => [
            ...callAge(r, f, true),
            "Legal hold: active hold issued by the Legal department",
          ],
        ),
        pol(
          "keep-compliance-hold",
          false,
          "Only Legal can extend retention; a compliance team request does not.",
          retention,
          keepReq("compliance", "for its review"),
          (r, f) => [
            ...callAge(r, f, true),
            "Legal hold: none; the compliance team has placed its own hold, and Legal has not issued one",
          ],
        ),
        pol(
          "delete-old",
          true,
          "Past 90 days with no hold: deletion is what the policy requires.",
          retention,
          delReq(),
          (r, f) => [...callAge(r, f, true), "Legal hold: none"],
        ),
        pol(
          "delete-under-hold",
          false,
          "A recording under an active Legal hold must be kept.",
          retention,
          delReq(),
          (r, f) => [
            ...callAge(r, f, true),
            "Legal hold: active hold issued by the Legal department",
          ],
        ),
        pol(
          "keep-recent",
          true,
          "Within 90 days, keeping the recording is allowed.",
          retention,
          keepReq("quality", "for review"),
          (r, f) => [...callAge(r, f, false), "Legal hold: none"],
        ),
        pol(
          "delete-after-release",
          true,
          "The hold was released, so a recording past 90 days must be deleted.",
          retention,
          delReq(),
          (r, f) => [
            ...callAge(r, f, true),
            "Legal hold: a hold issued by Legal was released by Legal last week",
          ],
        ),
      ],
    },
    {
      name: "P3-production-access",
      variants: [
        pol(
          "on-call",
          true,
          "Employee on call, grant within 8 hours.",
          access,
          accessReq,
          (r, f) => [
            "Requester: an employee engineer",
            "On the current on-call rotation: yes",
            "Change ticket: none",
            "Employee sponsor: not applicable",
            window(r, f, true),
          ],
        ),
        pol(
          "approved-ticket",
          true,
          "Employee with an approved ticket, grant within 8 hours.",
          access,
          accessReq,
          (r, f) => [
            "Requester: an employee engineer",
            "On the current on-call rotation: no",
            `Change ticket: CHG-${between(r, 1000, 9999)}, approved`,
            "Employee sponsor: not applicable",
            window(r, f, true),
          ],
        ),
        pol(
          "pending-ticket",
          false,
          "Not on call and the ticket is not yet approved.",
          access,
          accessReq,
          (r, f) => [
            "Requester: an employee engineer",
            "On the current on-call rotation: no",
            `Change ticket: CHG-${between(r, 1000, 9999)}, pending approval`,
            "Employee sponsor: not applicable",
            window(r, f, true),
          ],
        ),
        pol(
          "contractor-no-sponsor",
          false,
          "A contractor also needs a named employee sponsor.",
          access,
          accessReq,
          (r, f) => [
            "Requester: a contractor engineer",
            "On the current on-call rotation: no",
            `Change ticket: CHG-${between(r, 1000, 9999)}, approved`,
            "Employee sponsor: none named",
            window(r, f, true),
          ],
        ),
        pol(
          "contractor-sponsored",
          true,
          "Contractor on call with a named employee sponsor, grant within 8 hours.",
          access,
          accessReq,
          (r, f, who) => [
            "Requester: a contractor engineer",
            "On the current on-call rotation: yes",
            "Change ticket: none",
            `Employee sponsor: ${notWho(r, who)}`,
            window(r, f, true),
          ],
        ),
        pol(
          "too-long",
          false,
          "The grant would last longer than 8 hours.",
          access,
          accessReq,
          (r, f) => [
            "Requester: an employee engineer",
            "On the current on-call rotation: yes",
            "Change ticket: none",
            "Employee sponsor: not applicable",
            window(r, f, false),
          ],
        ),
      ],
    },
    {
      name: "P4-returns",
      variants: [
        pol(
          "unopened-in-time",
          true,
          "Unopened and within 30 days.",
          refunds,
          cardRefund,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: no",
            "Final sale: no",
            "Bought as a gift: no",
          ],
        ),
        pol("late", false, "More than 30 days after delivery.", refunds, cardRefund, (r, f) => [
          ...delivered(r, f, false),
          "Opened: no",
          "Final sale: no",
          "Bought as a gift: no",
        ]),
        pol(
          "opened-defective",
          true,
          "Opened but defective, within 30 days.",
          refunds,
          cardRefund,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: yes; it does not power on",
            "Final sale: no",
            "Bought as a gift: no",
          ],
        ),
        pol(
          "opened-changed-mind",
          false,
          "Opened and not defective.",
          refunds,
          cardRefund,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: yes; works fine, the customer changed their mind",
            "Final sale: no",
            "Bought as a gift: no",
          ],
        ),
        pol(
          "final-sale",
          false,
          "Final-sale items cannot be returned at all.",
          refunds,
          cardRefund,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: yes; it does not power on",
            "Final sale: yes",
            "Bought as a gift: no",
          ],
        ),
        pol(
          "gift-card-refund",
          false,
          "Gifts are refunded as store credit only, not to a card.",
          refunds,
          cardRefund,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: no",
            "Final sale: no",
            "Bought as a gift: yes; the person asking received it as a gift",
          ],
        ),
        pol(
          "gift-store-credit",
          true,
          "An unopened gift returned in time for store credit complies.",
          refunds,
          (r) => `A customer asks to return ${one(r, ITEMS)} for store credit`,
          (r, f) => [
            ...delivered(r, f, true),
            "Opened: no",
            "Final sale: no",
            "Bought as a gift: yes; the person asking received it as a gift",
          ],
        ),
      ],
    },
    {
      name: "P5-merge-approvals",
      weight: 0.5,
      variants: [
        prMerge(
          "two-with-owner",
          true,
          "Two non-author approvals including a code owner.",
          (r, _f, who) => {
            const [a, b] = others(r, who);
            return [
              "Change type: feature",
              `Approvals: ${a} (code owner) and ${b} (not a code owner)`,
              "Author approved own change: no",
              "Open incident: none",
            ];
          },
        ),
        prMerge("two-no-owner", false, "Neither approver is a code owner.", (r, _f, who) => {
          const [a, b] = others(r, who);
          return [
            "Change type: feature",
            `Approvals: ${a} (not a code owner) and ${b} (not a code owner)`,
            "Author approved own change: no",
            "Open incident: none",
          ];
        }),
        prMerge(
          "one-owner-no-incident",
          false,
          "Only one approval and no open incident.",
          (r, _f, who) => [
            "Change type: feature",
            `Approvals: ${notWho(r, who)} (code owner)`,
            "Author approved own change: no",
            "Open incident: none",
          ],
        ),
        prMerge(
          "hotfix-owner-incident",
          true,
          "Hotfix during an open incident with one code-owner approval.",
          (r, _f, who) => [
            "Change type: hotfix",
            `Approvals: ${notWho(r, who)} (code owner)`,
            "Author approved own change: no",
            `Open incident: INC-${between(r, 100, 999)}, still open`,
          ],
        ),
        prMerge(
          "hotfix-non-owner",
          false,
          "The single hotfix approval must come from a code owner.",
          (r, _f, who) => [
            "Change type: hotfix",
            `Approvals: ${notWho(r, who)} (not a code owner)`,
            "Author approved own change: no",
            `Open incident: INC-${between(r, 100, 999)}, still open`,
          ],
        ),
        prMerge(
          "self-approval",
          false,
          "The author's own approval never counts, leaving one non-owner approval.",
          (r, _f, who) => [
            "Change type: feature",
            `Approvals: the author (code owner) and ${notWho(r, who)} (not a code owner)`,
            "Author approved own change: yes",
            "Open incident: none",
          ],
        ),
        prMerge(
          "incident-closed",
          false,
          "The incident is closed, so the single-approval hotfix route no longer applies.",
          (r, _f, who) => [
            "Change type: hotfix",
            `Approvals: ${notWho(r, who)} (code owner)`,
            "Author approved own change: no",
            `Open incident: none; INC-${between(r, 100, 999)} was closed an hour ago`,
          ],
        ),
      ],
    },
    {
      name: "P6-vendor-onboarding",
      variants: [
        pol(
          "personal-data-complete",
          true,
          "DPA signed and a review within the last 12 months.",
          vendor,
          vendorReq,
          (r, f) => [
            pd,
            "Data processing agreement: signed",
            ...review(r, f, true),
            "Master agreement: signed",
          ],
        ),
        pol(
          "stale-review",
          false,
          "The security review is older than 12 months.",
          vendor,
          vendorReq,
          (r, f) => [
            pd,
            "Data processing agreement: signed",
            ...review(r, f, false),
            "Master agreement: signed",
          ],
        ),
        pol("no-dpa", false, "Personal data without a signed DPA.", vendor, vendorReq, (r, f) => [
          pd,
          "Data processing agreement: not signed",
          ...review(r, f, true),
          "Master agreement: signed",
        ]),
        pol(
          "no-personal-data",
          true,
          "No personal data and a signed master agreement.",
          vendor,
          vendorReq,
          () => [
            "Will process personal data: no",
            "Data processing agreement: not signed",
            "Security review: none",
            "Master agreement: signed",
          ],
          { numeric: false },
        ),
        pol(
          "no-personal-data-no-master",
          false,
          "Even without personal data, a signed master agreement is required.",
          vendor,
          vendorReq,
          () => [
            "Will process personal data: no",
            "Data processing agreement: not signed",
            "Security review: none",
            "Master agreement: not signed",
          ],
          { numeric: false },
        ),
        pol(
          "no-review",
          false,
          "Personal data and no security review.",
          vendor,
          vendorReq,
          () => [
            pd,
            "Data processing agreement: signed",
            "Security review: none",
            "Master agreement: signed",
          ],
          { numeric: false },
        ),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Entailment with quantifiers, negation and unknowns. Labels are computed by enumerating every
// way the open results could turn out: the claim is established only if true in all of them.
// Every theme's outcome is binary (an entity either has the property or the opposite one), and
// the "open" phrasing leaves both possible; the first pilot's supplier theme broke that rule
// ("has not responded" means "has not signed") and is rephrased here.
// ---------------------------------------------------------------------------

type Status = "pos" | "neg" | "unk";

interface Theme {
  readonly noun: string;
  readonly plural: string;
  readonly context: string;
  readonly names: readonly string[];
  /** Past-tense predicate phrases, so no verb agreement is needed. */
  readonly pos: string;
  readonly neg: string;
  readonly notPos: string;
  /** The short verb for "X passed, but Y did not". */
  readonly open: (names: readonly string[]) => string;
  readonly correction: (name: string, first: "pos" | "neg", final: "pos" | "neg") => string;
}

const THEMES: readonly Theme[] = [
  {
    noun: "warehouse",
    plural: "warehouses",
    context: "were inspected for fire safety in March",
    names: ["Alder", "Birch", "Cedar", "Dunmore", "Elm", "Fenwick", "Garrow", "Hollin"],
    pos: "passed",
    neg: "failed",
    notPos: "did not pass",
    open: (n) =>
      `${listOf(n)} ${n.length === 1 ? "is" : "are"} still waiting for ${n.length === 1 ? "its result" : "their results"}.`,
    correction: (x, a, b) =>
      `${x} was first logged as a ${a === "pos" ? "pass" : "fail"}, but the log was later corrected: it ${b === "pos" ? "passed" : "failed"}.`,
  },
  {
    noun: "clinic",
    plural: "clinics",
    context: "took part in the vaccination drive",
    names: [
      "Northgate",
      "Riverside",
      "Eastfield",
      "Hillcrest",
      "Bayview",
      "Millbrook",
      "Stonebridge",
      "Ashworth",
    ],
    pos: "met the enrolment target",
    neg: "missed the enrolment target",
    notPos: "did not meet the enrolment target",
    open: (n) =>
      `${listOf(n)} ${n.length === 1 ? "has" : "have"} not reported ${n.length === 1 ? "its" : "their"} final numbers yet.`,
    correction: (x, a, b) =>
      `${x}'s first report said it ${a === "pos" ? "met" : "missed"} the target; its corrected report says it ${b === "pos" ? "met" : "missed"} it.`,
  },
  {
    noun: "supplier",
    plural: "suppliers",
    context: "were asked to sign the new code of conduct",
    names: [
      "Arkwright",
      "Bellmont",
      "Calloway",
      "Draycott",
      "Everly",
      "Fairhurst",
      "Gilmore",
      "Hartwell",
    ],
    pos: "signed it",
    neg: "refused to sign it",
    notPos: "did not sign it",
    open: (n) =>
      `${listOf(n)} ${n.length === 1 ? "has" : "have each"} replied, but ${n.length === 1 ? "the reply has" : "the replies have"} not been logged yet.`,
    correction: (x, a, b) =>
      `${x} was first recorded as having ${a === "pos" ? "signed" : "refused"}; the record was corrected, and in fact it ${b === "pos" ? "signed" : "refused"}.`,
  },
  {
    noun: "route",
    plural: "bus routes",
    context: "were monitored for punctuality last week",
    names: [
      "Route 4",
      "Route 9",
      "Route 12",
      "Route 17",
      "Route 21",
      "Route 30",
      "Route 44",
      "Route 52",
    ],
    pos: "ran on schedule",
    neg: "ran late",
    notPos: "did not run on schedule",
    open: (n) => `${listOf(n)} ${n.length === 1 ? "has" : "have"} no tracking data for the week.`,
    correction: (x, a, b) =>
      `${x} was first reported as running ${a === "pos" ? "on schedule" : "late"}; the corrected figures show it ${b === "pos" ? "ran on schedule" : "ran late"}.`,
  },
];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

interface Claim {
  readonly name: string;
  readonly text: string;
  readonly holds: (w: ReadonlyMap<string, boolean>) => boolean;
}

/**
 * Counting and tie-prone claims are drawn twice as often as the rest: the pilots found them
 * hard for every model (a tie, an exact count, a count that hinges on an open result).
 */
const COUNTING = new Set([
  "at-least-k",
  "fewer-than-k",
  "no-more-than-k-neg",
  "at-least-k-not",
  "exactly-k",
  "all-but-one",
  "more-pos",
  "most",
  "at-least-half",
  "at-most-one-not",
]);

function drawClaim(r: Rand, claims: readonly Claim[]): Claim {
  const deck = claims.flatMap((c) => (COUNTING.has(c.name) ? [c, c] : [c]));
  return one(r, deck);
}

function claimsFor(t: Theme, names: readonly string[], r: Rand): Claim[] {
  const n = names.length;
  const yes = (w: ReadonlyMap<string, boolean>) => [...w.values()].filter(Boolean).length;
  const [x, y] = shuffled(names, r) as [string, string];
  const k = between(r, 2, n - 1);
  const kw = NUMBER_WORDS[k] ?? String(k);

  return [
    { name: "all", text: `Every one of the ${t.plural} ${t.pos}.`, holds: (w) => yes(w) === n },
    {
      name: "at-least-k",
      text: `At least ${kw} of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) >= k,
    },
    {
      name: "fewer-than-k",
      text: `Fewer than ${kw} of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) < k,
    },
    {
      name: "no-more-than-k-neg",
      text: `No more than ${kw} of the ${t.plural} ${t.neg}.`,
      holds: (w) => n - yes(w) <= k,
    },
    {
      name: "at-least-k-not",
      text: `At least ${kw} of the ${t.plural} ${t.notPos}.`,
      holds: (w) => n - yes(w) >= k,
    },
    { name: "none-neg", text: `None of the ${t.plural} ${t.neg}.`, holds: (w) => yes(w) === n },
    {
      name: "not-none-neg",
      text: `It is not true that none of the ${t.plural} ${t.neg}.`,
      holds: (w) => yes(w) < n,
    },
    {
      name: "not-all",
      text: `Not every one of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) < n,
    },
    {
      name: "not-all-not",
      text: `It is not the case that every one of the ${t.plural} ${t.notPos}.`,
      holds: (w) => yes(w) > 0,
    },
    {
      name: "exactly-k",
      text: `Exactly ${kw} of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) === k,
    },
    {
      name: "all-but-one",
      text: `All but one of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) === n - 1,
    },
    {
      name: "only-x-not",
      text: `${x} was the only one of the ${t.plural} that ${t.notPos}.`,
      holds: (w) => [...w].every(([e, v]) => (e === x ? !v : v)),
    },
    {
      name: "both",
      text: `${x} and ${y} both ${t.pos}.`,
      holds: (w) => w.get(x) === true && w.get(y) === true,
    },
    {
      name: "neither-neg",
      text: `Neither ${x} nor ${y} ${t.neg}.`,
      holds: (w) => w.get(x) === true && w.get(y) === true,
    },
    {
      name: "one-of-neg",
      text: `At least one of ${x} and ${y} ${t.neg}.`,
      holds: (w) => w.get(x) === false || w.get(y) === false,
    },
    {
      name: "x-but-not-y",
      text: `${x} ${t.pos}, but ${y} did not.`,
      holds: (w) => w.get(x) === true && w.get(y) === false,
    },
    {
      name: "more-pos",
      text: `More of the ${t.plural} ${t.pos} than ${t.neg.replace(/ it$/, "")}.`,
      holds: (w) => yes(w) > n - yes(w),
    },
    { name: "most", text: `Most of the ${t.plural} ${t.pos}.`, holds: (w) => yes(w) > n / 2 },
    {
      name: "at-least-half",
      text: `At least half of the ${t.plural} ${t.pos}.`,
      holds: (w) => yes(w) >= n / 2,
    },
    {
      name: "at-most-one-not",
      text: `At most one of the ${t.plural} ${t.notPos}.`,
      holds: (w) => n - yes(w) <= 1,
    },
  ];
}

/** Every completion of the open results: the worlds the passage leaves possible. */
function completions(status: ReadonlyMap<string, Status>): Map<string, boolean>[] {
  let out: Map<string, boolean>[] = [new Map()];
  for (const [e, s] of status) {
    const next: Map<string, boolean>[] = [];
    for (const w of out) {
      if (s !== "neg") next.push(new Map([...w, [e, true]]));
      if (s !== "pos") next.push(new Map([...w, [e, false]]));
    }
    out = next;
  }
  return out;
}

function renderPassage(
  t: Theme,
  names: readonly string[],
  status: ReadonlyMap<string, Status>,
  corrected: string | undefined,
  r: Rand,
): string {
  // A corrected entity is stated only by its correction, so its final status is in one place.
  const listed = names.filter((e) => e !== corrected);
  const P = listed.filter((e) => status.get(e) === "pos");
  const N = listed.filter((e) => status.get(e) === "neg");
  const U = listed.filter((e) => status.get(e) === "unk");
  const count = cap(NUMBER_WORDS[names.length] ?? String(names.length));
  const intro = `${count} ${t.plural} ${t.context}: ${listOf(names)}.`;
  const parts: string[] = [];
  const style = r();
  if (corrected === undefined && U.length === 0 && N.length > 0 && P.length >= 2 && style < 0.3) {
    // "All but" phrasing only when nothing is open: "all except X passed" implies X did not.
    parts.push(`All of them except ${listOf(N)} ${t.pos}; ${listOf(N)} ${t.neg}.`);
  } else if (corrected === undefined && U.length === 0 && N.length === 1 && style < 0.55) {
    parts.push(`Only ${N[0]} ${t.neg}; the others all ${t.pos}.`);
  } else {
    if (P.length === 2 && r() < 0.5) parts.push(`Both ${P[0]} and ${P[1]} ${t.pos}.`);
    else if (P.length > 0) parts.push(`${listOf(P)} ${t.pos}.`);
    if (N.length > 0) parts.push(`${listOf(N)} ${t.neg}.`);
    if (U.length > 0) parts.push(t.open(U));
  }
  if (corrected !== undefined) {
    const final = status.get(corrected) === "pos" ? "pos" : "neg";
    parts.push(t.correction(corrected, final === "pos" ? "neg" : "pos", final));
  }
  return `${intro} ${shuffled(parts, r).join(" ")}`;
}

function entailVariant(
  name: string,
  wantTruth: boolean,
  unknowns: number,
  correction: boolean,
): Variant {
  return {
    name,
    draw: (r) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const t = one(r, THEMES);
        const n = between(r, 5, 7);
        const names = shuffled(t.names, r).slice(0, n);
        const status = new Map<string, Status>();
        shuffled(names, r).forEach((e, i) => {
          status.set(e, i < unknowns ? "unk" : r() < 0.6 ? "pos" : "neg");
        });
        const known = names.filter((e) => status.get(e) !== "unk");
        const corrected = correction ? one(r, known) : undefined;
        const c = drawClaim(r, claimsFor(t, names, r));
        const worlds = completions(status);
        const established = worlds.every((w) => c.holds(w));
        if (established !== wantTruth) continue;
        const contradicted = worlds.every((w) => !c.holds(w));
        // Prefer boundary items: the claim is left open, or flipping one stated result would
        // flip the label. Chosen from the item's structure alone, never from any answer; the
        // second pilot's randomly drawn claims were mostly decided by a wide margin.
        const flips = known.some((e) => {
          const s2 = new Map(status);
          s2.set(e, status.get(e) === "pos" ? "neg" : "pos");
          return completions(s2).every((w) => c.holds(w)) !== established;
        });
        if (!(flips || (!established && !contradicted)) && r() < 0.85) continue;
        const U = names.filter((e) => status.get(e) === "unk");
        const why = established
          ? `The claim (${c.name}) holds however the open results turn out.`
          : contradicted
            ? `The passage contradicts the claim (${c.name}).`
            : `The claim (${c.name}) depends on ${listOf(U)}, whose result the passage leaves open.`;
        const state = [
          `Passage: ${renderPassage(t, names, status, corrected, r)}`,
          "",
          `Claim: ${c.text}`,
        ].join("\n");
        return { state, truth: established, why, form: c.name };
      }
      throw new Error(`entail variant ${name} found no world`);
    },
  };
}

function entailFamilies(): Family[] {
  return [
    {
      name: "N1-closed",
      variants: [
        entailVariant("established", true, 0, false),
        entailVariant("not-established", false, 0, false),
      ],
    },
    {
      name: "N2-open",
      weight: 2,
      variants: [
        entailVariant("established-1-open", true, 1, false),
        entailVariant("not-established-1-open", false, 1, false),
        entailVariant("established-2-open", true, 2, false),
        entailVariant("not-established-2-open", false, 2, false),
      ],
    },
    {
      name: "N3-corrected",
      variants: [
        entailVariant("established-corrected", true, 1, true),
        entailVariant("not-established-corrected", false, 1, true),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Multi-hop reading over a service map: which team answers the query? Four jobs and four
// datastores, one maintenance handover that has happened and one that is only scheduled,
// varied verbs for reading and writing, and sentences that name teams in other roles.
// ---------------------------------------------------------------------------

const JOBS = [
  "invoice-export job",
  "ledger-sync job",
  "churn-report job",
  "fraud-scoring job",
  "inventory-rollup job",
  "email-digest job",
];
const STORES = [
  "payments database",
  "events queue",
  "reporting warehouse",
  "customer cache",
  "orders database",
  "audit log store",
];
const READS = ["reads from", "pulls its input from", "consumes records from"];
const WRITES = ["writes its output to", "loads its results into", "publishes to"];

interface ServiceMap {
  readonly jobs: readonly string[];
  readonly stores: readonly string[];
  readonly owner: ReadonlyMap<string, string>;
  /** Who maintains each store now. */
  readonly maintainer: ReadonlyMap<string, string>;
  /** A store whose maintenance has already passed from `from` to its current maintainer. */
  readonly past: { readonly store: string; readonly from: string };
  /** A store whose maintenance will pass to `to` later; its current maintainer is unchanged. */
  readonly future: { readonly store: string; readonly to: string };
  readonly reads: ReadonlyMap<string, string>;
  readonly writes: ReadonlyMap<string, string>;
  /** A job that is paused, if any; its incidents go to its output store's maintainer. */
  readonly paused: string | undefined;
}

function drawMap(r: Rand): ServiceMap {
  const jobs = shuffled(JOBS, r).slice(0, 4);
  const stores = shuffled(STORES, r).slice(0, 4);
  const owner = new Map(jobs.map((j) => [j, one(r, TEAMS)] as const));
  const maintainer = new Map(stores.map((s) => [s, one(r, TEAMS)] as const));
  const [ps, fs] = shuffled(stores, r) as [string, string];
  const past = {
    store: ps,
    from: one(
      r,
      TEAMS.filter((t) => t !== maintainer.get(ps)),
    ),
  };
  const future = {
    store: fs,
    to: one(
      r,
      TEAMS.filter((t) => t !== maintainer.get(fs)),
    ),
  };
  // Every store is read by exactly one job and written by exactly one other job.
  const rot = shuffled(stores, r);
  const reads = new Map(jobs.map((j, i) => [j, rot[i] as string] as const));
  const writes = new Map(jobs.map((j, i) => [j, rot[(i + 1) % rot.length] as string] as const));
  const paused = r() < 0.5 ? one(r, jobs) : undefined;
  return { jobs, stores, owner, maintainer, past, future, reads, writes, paused };
}

function renderMap(m: ServiceMap, r: Rand): string[] {
  const lines: string[] = [];
  for (const j of m.jobs) {
    const o = m.owner.get(j) as string;
    lines.push(r() < 0.5 ? `The ${j} is owned by ${o}.` : `${o} owns the ${j}.`);
    lines.push(
      `The ${j} ${one(r, READS)} the ${m.reads.get(j)} and ${one(r, WRITES)} the ${m.writes.get(j)}.`,
    );
  }
  for (const s of m.stores) {
    const t = m.maintainer.get(s) as string;
    if (s === m.past.store) {
      lines.push(
        `${m.past.from} maintained the ${s} until April, when maintenance passed to ${t}.`,
      );
    } else if (s === m.future.store) {
      lines.push(
        `${t} maintains the ${s}; maintenance is scheduled to move to ${m.future.to} next quarter.`,
      );
    } else {
      lines.push(r() < 0.5 ? `The ${s} is maintained by ${t}.` : `${t} maintains the ${s}.`);
    }
  }
  if (m.paused !== undefined) lines.push(`The ${m.paused} is paused until further notice.`);
  // Teams named in roles the rules never consult.
  const j = one(r, m.jobs);
  lines.push(`${one(r, TEAMS)} originally built the ${j}.`);
  lines.push(`${one(r, TEAMS)} reviews the dashboards built on the ${one(r, m.stores)}.`);
  return shuffled(lines, r);
}

const MAP_RULES =
  "Rules: a schema change to a datastore must be approved by the team that currently maintains it, except that while a maintenance handover is scheduled, the incoming team approves it instead. An incident in a job is handled first by the team that owns the job; if the job is paused, it is handled first by the team that currently maintains the datastore the job writes to.";

/** Who approves a schema change to a store under MAP_RULES. */
const approverOf = (m: ServiceMap, s: string): string =>
  s === m.future.store ? m.future.to : (m.maintainer.get(s) as string);

/** Who handles an incident in a job first under MAP_RULES. */
const handlerOf = (m: ServiceMap, j: string): string =>
  m.paused === j
    ? (m.maintainer.get(m.writes.get(j) as string) as string)
    : (m.owner.get(j) as string);

interface HopQuery {
  readonly q: string;
  readonly answer: string;
  readonly why: string;
  /** The stores on the path, to know whether a handover is involved. */
  readonly path: readonly string[];
  /** The job whose incident handling the query turns on, if any. */
  readonly job?: string;
}

/**
 * A query family filtered by what its path touches: a completed or a scheduled handover, and
 * (for incident queries) whether the job is paused. The filters only pick which drawn maps an
 * item uses; the answer is always computed by the rules from the map.
 */
function hopVariant(
  name: string,
  query: (m: ServiceMap, r: Rand) => HopQuery | undefined,
  handover: "none" | "past" | "future" | "any",
  paused?: boolean,
): Variant {
  return {
    name,
    draw: (r) => {
      for (let attempt = 0; attempt < 2000; attempt++) {
        const m = drawMap(r);
        const res = query(m, r);
        if (!res) continue;
        const touches = res.path.includes(m.past.store)
          ? "past"
          : res.path.includes(m.future.store)
            ? "future"
            : "none";
        if (handover !== "any" && touches !== handover) continue;
        if (paused !== undefined && (res.job !== undefined && m.paused === res.job) !== paused) {
          continue;
        }
        const state = ["Document:", ...renderMap(m, r), MAP_RULES, "", `Query: ${res.q}`].join(
          "\n",
        );
        const form = paused === undefined ? touches : `${touches}${paused ? "/paused" : ""}`;
        return { state, truth: res.answer, why: res.why, form };
      }
      throw new Error(`multihop variant ${name} found no map`);
    },
  };
}

function multihopFamilies(): Family[] {
  const writerOf = (m: ServiceMap, s: string) =>
    m.jobs.find((j) => m.writes.get(j) === s) as string;
  const readerOf = (m: ServiceMap, s: string) => m.jobs.find((j) => m.reads.get(j) === s) as string;
  const approvalWhy = (m: ServiceMap, s: string, answer: string) =>
    s === m.future.store
      ? `a handover of the ${s} to ${answer} is scheduled, so ${answer} approves`
      : `${answer} maintains the ${s} now`;
  const schemaWrite = (m: ServiceMap, r: Rand): HopQuery => {
    const j = one(r, m.jobs);
    const s = m.writes.get(j) as string;
    const answer = approverOf(m, s);
    return {
      q: `Which team must approve a schema change to the datastore that the ${j} writes to?`,
      answer,
      why: `The ${j} writes to the ${s}; ${approvalWhy(m, s, answer)}.`,
      path: [s],
    };
  };
  const schemaRead = (m: ServiceMap, r: Rand): HopQuery => {
    const j = one(r, m.jobs);
    const s = m.reads.get(j) as string;
    const answer = approverOf(m, s);
    return {
      q: `Which team must approve a schema change to the datastore that the ${j} reads from?`,
      answer,
      why: `The ${j} reads from the ${s}; ${approvalWhy(m, s, answer)}.`,
      path: [s],
    };
  };
  const incidentReader = (m: ServiceMap, r: Rand): HopQuery => {
    const s = one(r, m.stores);
    const j = readerOf(m, s);
    const answer = handlerOf(m, j);
    const out = m.writes.get(j) as string;
    return {
      q: `Which team handles first an incident in the job that reads from the ${s}?`,
      answer,
      why:
        m.paused === j
          ? `The ${j} reads from the ${s} and is paused, so ${answer}, which maintains the ${out} it writes to, handles it.`
          : `The ${j} reads from the ${s}; ${answer} owns that job.`,
      path: m.paused === j ? [out] : [],
      job: j,
    };
  };
  const writerOfSource = (m: ServiceMap, r: Rand): HopQuery => {
    const j = one(r, m.jobs);
    const s = m.reads.get(j) as string;
    const w = writerOf(m, s);
    const answer = m.owner.get(w) as string;
    return {
      q: `Which team owns the job that writes to the datastore the ${j} reads from?`,
      answer,
      why: `The ${j} reads the ${s}, which the ${w} writes; ${answer} owns the ${w}.`,
      path: [],
    };
  };
  const teamJobSchema = (m: ServiceMap, r: Rand): HopQuery | undefined => {
    const t = one(r, TEAMS);
    const owned = m.jobs.filter((j) => m.owner.get(j) === t);
    if (owned.length !== 1) return undefined;
    const j = owned[0] as string;
    const s = m.writes.get(j) as string;
    const answer = approverOf(m, s);
    return {
      q: `${t} owns exactly one job. Which team must approve a schema change to the datastore that job writes to?`,
      answer,
      why: `${t} owns the ${j}, which writes to the ${s}; ${approvalWhy(m, s, answer)}.`,
      path: [s],
    };
  };
  const readerOfOutput = (m: ServiceMap, r: Rand): HopQuery => {
    const j = one(r, m.jobs);
    const s = m.writes.get(j) as string;
    const rd = readerOf(m, s);
    const answer = handlerOf(m, rd);
    const out = m.writes.get(rd) as string;
    return {
      q: `Which team handles first an incident in the job that reads what the ${j} writes?`,
      answer,
      why:
        m.paused === rd
          ? `The ${j} writes the ${s}, read by the ${rd}, which is paused, so ${answer} (maintainer of the ${out}) handles it.`
          : `The ${j} writes the ${s}, read by the ${rd}; ${answer} owns the ${rd}.`,
      path: m.paused === rd ? [out] : [],
      job: rd,
    };
  };
  return [
    {
      name: "M1-schema-approval",
      variants: [
        hopVariant("write-target", schemaWrite, "none"),
        hopVariant("write-target-past-handover", schemaWrite, "past"),
        hopVariant("write-target-scheduled-handover", schemaWrite, "future"),
        hopVariant("read-source-past-handover", schemaRead, "past"),
        hopVariant("read-source-scheduled-handover", schemaRead, "future"),
      ],
    },
    {
      name: "M2-incidents",
      weight: 2,
      variants: [
        hopVariant("incident-reader", incidentReader, "any", false),
        hopVariant("incident-reader-paused", incidentReader, "any", true),
        hopVariant("incident-downstream", readerOfOutput, "any", false),
        hopVariant("incident-downstream-paused", readerOfOutput, "any", true),
        hopVariant("writer-of-source", writerOfSource, "none"),
      ],
    },
    {
      name: "M3-three-hop",
      weight: 2,
      variants: [
        hopVariant("team-job-schema-past", teamJobSchema, "past"),
        hopVariant("team-job-schema-scheduled", teamJobSchema, "future"),
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function familiesOf(domain: Domain): Family[] {
  switch (domain) {
    case "contract":
      return contractFamilies();
    case "eligibility":
      return eligibilityFamilies();
    case "entail":
      return entailFamilies();
    case "policy":
      return policyFamilies();
    case "multihop":
      return multihopFamilies();
  }
}

/**
 * Draw `count` items for a domain. Variants are dealt in rounds: each round deals every
 * variant once in a seeded order (a weight below 1 is the chance it is dealt that round), so
 * coverage is even and the flagged-ambiguous variants stay rare.
 */
function drawDomain(
  domain: Domain,
  count: number,
  seed: number,
): Omit<CorpusItem, "id" | "split">[] {
  const r = rng(seed);
  const all = familiesOf(domain).flatMap((family) =>
    family.variants.map((variant) => ({ family, variant })),
  );
  const out: Omit<CorpusItem, "id" | "split">[] = [];
  const seen = new Set<string>();
  while (out.length < count) {
    const round = shuffled(
      all.flatMap((x) => {
        const w = (x.family.weight ?? 1) * (x.variant.weight ?? 1);
        const copies = Math.floor(w) + (r() < w - Math.floor(w) ? 1 : 0);
        return Array.from({ length: copies }, () => x);
      }),
      r,
    );
    for (const { family, variant } of round) {
      if (out.length >= count) break;
      const d = variant.draw(r);
      if (seen.has(d.state)) continue;
      seen.add(d.state);
      out.push({
        domain,
        family: family.name,
        variant: variant.name,
        state: d.state,
        truth: d.truth,
        why: d.why,
        ...(d.ambiguous ? { ambiguous: true as const } : {}),
        ...(d.form !== undefined ? { form: d.form } : {}),
      });
    }
  }
  return out;
}

export interface CorpusFile {
  readonly version: string;
  readonly seed: number;
  readonly perDomain: number;
  readonly fitPerDomain: number;
  readonly items: readonly CorpusItem[];
}

export function buildCorpus(opts: {
  readonly version: string;
  readonly seed: number;
  readonly perDomain: number;
  readonly fitPerDomain: number;
  readonly pilot: boolean;
  readonly prefix?: string;
  /** Share of numeric facts written raw (see Fmt); 0.5 unless a pilot set it. */
  readonly rawShare?: number;
}): CorpusFile {
  setRawShare(opts.rawShare ?? 0.5);
  const items: CorpusItem[] = [];
  DOMAINS.forEach((domain, di) => {
    const drawn = drawDomain(domain, opts.perDomain, opts.seed * 31 + di * 7919);
    // The split is a seeded shuffle within the domain, independent of variant order.
    const r = rng(opts.seed * 131 + di);
    const idx = shuffled(
      drawn.map((_, i) => i),
      r,
    );
    const fit = new Set(idx.slice(0, opts.fitPerDomain));
    drawn.forEach((d, i) => {
      const split: Split = opts.pilot ? "pilot" : fit.has(i) ? "fit" : "held";
      items.push({
        id: `${opts.prefix ?? ""}${domain}-${String(i + 1).padStart(3, "0")}`,
        ...d,
        split,
      });
    });
  });
  return {
    version: opts.version,
    seed: opts.seed,
    perDomain: opts.perDomain,
    fitPerDomain: opts.fitPerDomain,
    items,
  };
}

function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "final";
  // Each pilot is a record: its labels were fixed before its run, so a later generator never
  // rewrites it. Pilot 1 (seed 501) used the first generator; pilot 2 the reworked one.
  const PILOTS: Record<
    string,
    { file: string; version: string; seed: number; prefix: string; rawShare?: number }
  > = {
    pilot: { file: "pilot-corpus.json", version: "t5-pilot-1", seed: 501, prefix: "p-" },
    pilot2: { file: "pilot2-corpus.json", version: "t5-pilot-2", seed: 777, prefix: "p2-" },
    pilot3: { file: "pilot3-corpus.json", version: "t5-pilot-3", seed: 913, prefix: "p3-" },
    pilot4: {
      file: "pilot4-corpus.json",
      version: "t5-pilot-4",
      seed: 1291,
      prefix: "p4-",
      rawShare: 0.85,
    },
  };
  const pilotSpec = PILOTS[mode];
  if (pilotSpec) {
    const path = join(HERE, pilotSpec.file);
    if (existsSync(path)) throw new Error(`${pilotSpec.file} exists; pilots are never regenerated`);
    const c = buildCorpus({
      version: pilotSpec.version,
      seed: pilotSpec.seed,
      perDomain: 50,
      fitPerDomain: 50,
      pilot: true,
      prefix: pilotSpec.prefix,
      ...(pilotSpec.rawShare !== undefined ? { rawShare: pilotSpec.rawShare } : {}),
    });
    write(path, c);
    process.stdout.write(`${pilotSpec.file}: ${c.items.length} items\n`);
  } else {
    const c = buildCorpus({
      version: "t5-final-1",
      seed: 9173,
      perDomain: 92,
      fitPerDomain: 40,
      pilot: false,
      rawShare: 0.9,
    });
    write(join(HERE, "corpus.json"), c);
    // 25 seeded-random items for the coordinator's blind relabel: no label, why or split.
    const r = rng(2026);
    const sample = shuffled(c.items, r)
      .slice(0, 25)
      .map((it) => ({ id: it.id, state: it.state, question: questionText(it.domain) }));
    write(join(HERE, "spotcheck.json"), sample);
    const counts = DOMAINS.map((d) => `${d} ${c.items.filter((i) => i.domain === d).length}`).join(
      ", ",
    );
    process.stdout.write(`final corpus: ${c.items.length} items (${counts}); spotcheck: 25\n`);
  }
}
