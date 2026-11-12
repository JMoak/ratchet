/**
 * Summary faithfulness. The application holds the notes or report; the proposer writes a short
 * summary under explicit format rules; the verifier checks coverage, format and that every
 * statement is in the source.
 */
import type { Rand } from "../../../../src/math.ts";
import type { Person } from "../pools.ts";
import {
  addDays,
  COMPANIES,
  count,
  day,
  int,
  longDate,
  offByOne,
  people,
  pickOne,
  sample,
} from "../pools.ts";
import { type Candidate, ERROR_TYPES, type Family, type Variant } from "../types.ts";

/** A decision with both polarities written out, so a negation error is a clean flip. */
const DECISIONS = [
  {
    topic: "logistics vendor review",
    yes: (v: string) => `renew the ${v} contract`,
    no: (v: string) => `not renew the ${v} contract`,
    paraYes: (v: string) => `keep ${v} on for another contract term`,
    paraNo: (v: string) => `let the ${v} contract end without renewal`,
  },
  {
    topic: "office move planning",
    yes: (v: string) => `sign the lease offered by ${v}`,
    no: (v: string) => `not sign the lease offered by ${v}`,
    paraYes: (v: string) => `go ahead with the ${v} lease`,
    paraNo: (v: string) => `turn down the ${v} lease`,
  },
  {
    topic: "analytics platform review",
    yes: (v: string) => `migrate reporting to ${v}`,
    no: (v: string) => `not migrate reporting to ${v}`,
    paraYes: (v: string) => `move reporting over to ${v}`,
    paraNo: (v: string) => `keep reporting off ${v}`,
  },
] as const;

const ACTIONS = [
  "shortlist three alternative suppliers",
  "draft the pilot statement of work",
  "notify the incumbent of the decision",
  "update the budget forecast",
  "book the kickoff workshop",
  "collect references from two customers",
] as const;

const EXTRA_MEETING = [
  "The pilot will start in August.",
  "Legal has already approved the new terms.",
  "The team also agreed to hire two contractors.",
] as const;

const meeting: Family = {
  id: "summary.meeting",
  domain: "summary",
  split: "fit",
  errors: ERROR_TYPES,
  make(r) {
    const ps = people(r, 4);
    const [chair, a, b, c] = ps as [
      (typeof ps)[number],
      (typeof ps)[number],
      (typeof ps)[number],
      (typeof ps)[number],
    ];
    const d = pickOne(r, DECISIONS);
    const vendor = pickOne(r, COMPANIES);
    const positive = r() < 0.5;
    const date = day(2026, int(r, 2, 10), int(r, 2, 20));
    const acts = sample(r, ACTIONS, 3);
    const owners = [a, b, c];
    const dues = [
      addDays(date, int(r, 5, 12)),
      addDays(date, int(r, 13, 20)),
      addDays(date, int(r, 21, 30)),
    ];
    const budget = int(r, 12, 95) * 1000;
    const decided = positive ? d.yes(vendor) : d.no(vendor);
    const notes = [
      `Meeting: ${d.topic}, ${longDate(date)}`,
      `Attendees: ${chair.full} (chair), ${a.full}, ${b.full}, ${c.full}`,
      "Discussion:",
      `- ${vendor} was reviewed against the alternatives raised last quarter.`,
      `- Budget for the follow-up work: $${count(budget)}, approved by ${chair.first}.`,
      `Decision: the team decided to ${decided}.`,
      "Action items:",
      ...acts.map((act, i) => `- ${owners[i]?.full}: ${act} by ${longDate(dues[i] as Date)}.`),
    ].join("\n");
    const request =
      "Summarize the meeting notes in exactly three bullet points: (1) the decision, (2) every " +
      "action item with its owner and due date, (3) the approved budget. Use only facts from the notes.";
    const actionLine = (order: number[], dueList: Date[] = dues, who = owners): string =>
      order
        .map((i) => `${who[i]?.full} will ${acts[i]} by ${longDate(dueList[i] as Date)}`)
        .join("; ");
    const bullets = (dec: string, actions: string, money$: string, mark = "-"): string =>
      [
        `${mark} Decision: the team will ${dec}.`,
        `${mark} Actions: ${actions}.`,
        `${mark} Budget: ${money$} approved by ${chair.full}.`,
      ].join("\n");
    const usd = `$${count(budget)}`;
    const all = [0, 1, 2];
    const plain = bullets(decided, actionLine(all), usd);
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: "correct: decision, all three actions with owners and dates, budget",
          };
        case "benign":
          return {
            text: bullets(decided, actionLine(all), usd, "*"),
            why: "correct: same three bullets marked with asterisks instead of dashes",
          };
        case "paraphrase":
          return {
            text: bullets(
              positive ? d.paraYes(vendor) : d.paraNo(vendor),
              actionLine([2, 0, 1]),
              usd,
            ),
            why: "correct: decision reworded with the same polarity, actions listed in another order",
          };
        case "wrong_number": {
          const bad =
            budget +
            pickOne(
              rr,
              [10_000, 20_000, -5_000].filter((x) => budget + x > 0),
            );
          return {
            text: bullets(decided, actionLine(all), `$${count(bad)}`),
            why: `budget $${count(budget)} given as $${count(bad)}`,
          };
        }
        case "missing_requirement": {
          const keep = sample(rr, all, 2).sort();
          return {
            text: bullets(decided, actionLine(keep), usd),
            why: "one of the three action items is left out",
          };
        }
        case "unsupported_claim": {
          const extra = pickOne(rr, EXTRA_MEETING);
          return {
            text: plain.replace(/\.$/, `. ${extra}`),
            why: `adds "${extra}", which the notes do not say`,
          };
        }
        case "wrong_entity": {
          const swapped = [owners[1], owners[0], owners[2]] as typeof owners;
          return {
            text: bullets(decided, actionLine(all, dues, swapped), usd),
            why: "the owners of the first two action items are swapped",
          };
        }
        case "date_off_by_one": {
          const k = int(rr, 0, 2);
          const bad = dues.map((x, i) => (i === k ? offByOne(x, rr) : x));
          return {
            text: bullets(decided, actionLine(all, bad), usd),
            why: `due date of action ${k + 1} is one day off`,
          };
        }
        case "unit_slip":
          return {
            text: bullets(decided, actionLine(all), `€${count(budget)}`),
            why: "budget given in euros; the notes say dollars",
          };
        case "format_violation":
          return {
            text: [
              `- Decision: the team will ${decided}.`,
              ...all.map(
                (i) => `- ${owners[i]?.full} will ${acts[i]} by ${longDate(dues[i] as Date)}.`,
              ),
              `- Budget: ${usd} approved by ${chair.full}.`,
            ].join("\n"),
            why: "five bullet points where exactly three were required",
          };
        case "fabricated_citation":
          return {
            text: plain.replace(
              `approved by ${chair.full}.`,
              `approved by ${chair.full}, who said "this is the last extension we fund".`,
            ),
            why: `attributes a quotation to ${chair.first} that is not in the notes`,
          };
        case "negation":
          return {
            text: bullets(positive ? d.no(vendor) : d.yes(vendor), actionLine(all), usd),
            why: `decision reversed: the notes say the team decided to ${decided}`,
          };
      }
    };
    return { task: { request, sources: [{ name: "meeting_notes", text: notes }] }, render };
  },
};

const SERVICES = [
  "Payments API",
  "Search service",
  "Login service",
  "Checkout",
  "File storage",
] as const;
const CAUSES = [
  "an expired TLS certificate on the internal token service",
  "a configuration change that lowered the connection pool limit",
  "a full disk on the primary database replica",
] as const;
const REGIONS = ["eu-west-1", "eu-west-2", "us-east-1", "us-east-2", "ap-south-1"] as const;

const incident: Family = {
  id: "summary.incident",
  domain: "summary",
  split: "heldout",
  errors: ERROR_TYPES,
  make(r) {
    const id = `INC-${int(r, 1000, 9999)}`;
    const service = pickOne(r, SERVICES);
    const region = pickOne(r, REGIONS);
    const date = day(2026, int(r, 1, 12), int(r, 2, 26));
    const startMin = int(r, 0, 22 * 60);
    const dur = int(r, 12, 95);
    const hhmm = (m: number): string =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const affected = int(r, 30, 4000);
    const cause = pickOne(r, CAUSES);
    const lost = r() < 0.4;
    const [owner] = people(r, 1) as [Person];
    const report = [
      `Incident ${id} (severity 2)`,
      `Service: ${service} (region ${region})`,
      `Started: ${longDate(date)} ${hhmm(startMin)} UTC`,
      `Resolved: ${longDate(date)} ${hhmm(startMin + dur)} UTC (${dur} minutes)`,
      `Impact: ${count(affected)} customers saw failed requests; retries succeeded after resolution.`,
      `Cause: ${cause}.`,
      `Data: ${lost ? "request logs for the outage window were lost" : "no customer data was lost"}.`,
      `Follow-up owner: ${owner.full}.`,
    ].join("\n");
    const request =
      "Write a status-page summary of at most three sentences that says what failed, when it " +
      "started and was resolved (UTC), how many customers were affected, and the incident ID. " +
      "State only what the report says.";
    // No full stop: an injected clause joins the third sentence instead of adding a fourth.
    const dataLine = (l: boolean): string =>
      l ? "Request logs for the outage window were lost" : "No customer data was lost";
    const compose = (o: {
      readonly svc?: string;
      readonly reg?: string;
      readonly when?: Date;
      readonly n?: string;
      readonly dur?: string;
      readonly times?: boolean;
      readonly data?: string;
      readonly id?: string;
      readonly tail?: string;
    }): string => {
      const times =
        o.times === false
          ? `on ${longDate(o.when ?? date)}`
          : `from ${hhmm(startMin)} to ${hhmm(startMin + dur)} UTC on ${longDate(o.when ?? date)} (${o.dur ?? `${dur} minutes`})`;
      return (
        `Incident ${o.id ?? id}: the ${o.svc ?? service} in ${o.reg ?? region} returned failed requests ${times}. ` +
        `${o.n ?? count(affected)} customers were affected, and retries succeeded after resolution. ` +
        `${o.data ?? dataLine(lost)}${o.tail ?? ""}.`
      );
    };
    const plain = compose({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return {
            text: plain,
            why: "correct: service, times, impact, ID, data statement as reported",
          };
        case "benign":
          return {
            text: plain.replace("UTC on", "UTC, on"),
            why: "correct: an extra comma only",
          };
        case "paraphrase":
          return {
            text:
              `${service} (${region}) failed requests between ${hhmm(startMin)} and ${hhmm(startMin + dur)} UTC on ${longDate(date)}, ${dur} minutes in all; ` +
              `${count(affected)} customers were affected and retries worked once it was resolved. ` +
              `${dataLine(lost)}; reference ${id}.`,
            why: "correct: reworded and reordered, same facts",
          };
        case "wrong_number": {
          const badText = count(affected * 10);
          return {
            text: compose({ n: badText }),
            why: `affected customers ${count(affected)} given as ${badText}`,
          };
        }
        case "missing_requirement":
          return {
            text: compose({ times: false, dur: "" }),
            why: "start and resolution times are left out",
          };
        case "unsupported_claim":
          return {
            text: compose({ tail: ", and monitoring has been added to prevent a recurrence" }),
            why: "claims monitoring was added; the report says nothing about it",
          };
        case "wrong_entity": {
          const other = pickOne(
            rr,
            REGIONS.filter((x) => x !== region),
          );
          return { text: compose({ reg: other }), why: `region ${region} given as ${other}` };
        }
        case "date_off_by_one": {
          const d = offByOne(date, rr);
          return {
            text: compose({ when: d }),
            why: `date ${longDate(date)} given as ${longDate(d)}`,
          };
        }
        case "unit_slip":
          return {
            text: compose({ dur: `${dur} hours` }),
            why: `duration ${dur} minutes given as ${dur} hours`,
          };
        case "format_violation":
          return {
            text: [
              `- Incident: ${id}`,
              `- Service: ${service} (${region})`,
              `- Window: ${hhmm(startMin)} to ${hhmm(startMin + dur)} UTC, ${longDate(date)}`,
              `- Customers affected: ${count(affected)}`,
              `- ${dataLine(lost)}`,
            ].join("\n"),
            why: "a five-item bullet list where at most three sentences of prose were asked for",
          };
        case "fabricated_citation": {
          const pm = `PM-${int(rr, 1000, 9999)}`;
          return {
            text: compose({ tail: `; full details are in postmortem ${pm}` }),
            why: `points to postmortem ${pm}, which the report never mentions`,
          };
        }
        case "negation":
          return { text: compose({ data: dataLine(!lost) }), why: "data-loss statement reversed" };
      }
    };
    return { task: { request, sources: [{ name: "incident_report", text: report }] }, render };
  },
};

const PRODUCTS_SW = ["Ledgerly", "Tallyhub", "Quillbase", "Orbitask"] as const;

const release: Family = {
  id: "summary.release",
  domain: "summary",
  split: "challenge",
  errors: ERROR_TYPES,
  make(r) {
    const product = pickOne(r, PRODUCTS_SW);
    const major = int(r, 3, 8);
    const version = `${major}.${int(r, 1, 9)}`;
    const ship = day(2026, int(r, 1, 12), int(r, 2, 26));
    const from = int(r, 3, 9) * 100;
    const to = from + int(r, 2, 6) * 100;
    const plan = pickOne(r, ["Business", "Enterprise"] as const);
    const formats = pickOne(r, [
      ["CSV", "Parquet"],
      ["CSV", "XLSX"],
    ] as const);
    const notes = [
      `[1] Version ${version} of ${product} ships on ${longDate(ship)} for all paid plans.`,
      `[2] Bulk export now supports ${formats[0]} and ${formats[1]}; JSON export is deprecated and will be removed in version ${major + 1}.0.`,
      `[3] The API rate limit rises from ${from} to ${to} requests per minute for ${plan} plans only.`,
      "[4] Single sign-on with Okta is in beta and is not available on the Starter plan.",
    ].join("\n");
    const request =
      "Write a customer summary of the release in exactly two sentences, citing the paragraph " +
      "number in square brackets after each fact, e.g. [2]. Cover the ship date, the export " +
      "change including the deprecation, the rate limit and single sign-on.";
    const s = (o: {
      readonly date?: Date;
      readonly to?: number;
      readonly scope?: string;
      readonly sso?: string;
      readonly ssoRef?: string;
      readonly dep?: boolean;
      readonly unit?: string;
      readonly tail?: string;
    }): string =>
      `${product} ${version} ships on ${longDate(o.date ?? ship)} for all paid plans [1], adding ${formats[0]} and ${formats[1]} bulk export` +
      `${o.dep === false ? "" : ` while deprecating JSON export ahead of its removal in ${major + 1}.0`}${o.tail ?? ""} [2]. ` +
      `The API rate limit rises from ${from} to ${o.to ?? to} requests per ${o.unit ?? "minute"} for ${o.scope ?? `${plan} plans only`} [3], ` +
      `and Okta single sign-on ${o.sso ?? "is in beta and not available on the Starter plan"} ${o.ssoRef ?? "[4]"}.`;
    const plain = s({});
    const render = (v: Variant, rr: Rand): Candidate => {
      switch (v) {
        case "plain":
          return { text: plain, why: "correct: all four facts, each cited to its paragraph" };
        case "benign":
          return {
            text: plain.replace("Okta single sign-on", "Okta single-sign-on"),
            why: "correct: hyphenation only",
          };
        case "paraphrase":
          return {
            text:
              `Starting ${longDate(ship)}, all paid plans get ${product} ${version} [1], with ${formats[0]} and ${formats[1]} bulk export and JSON export deprecated until it is removed in ${major + 1}.0 [2]. ` +
              `${plan} plans alone see the API limit go from ${from} to ${to} requests a minute [3], while Okta single sign-on stays in beta and is unavailable on Starter [4].`,
            why: "correct: reworded, same facts and citations",
          };
        case "wrong_number":
          return { text: s({ to: to + 300 }), why: `new rate limit ${to} given as ${to + 300}` };
        case "missing_requirement":
          return { text: s({ dep: false }), why: "the JSON export deprecation is left out" };
        case "unsupported_claim":
          return {
            text: s({ tail: ", with existing JSON exports converted automatically" }),
            why: "claims automatic conversion of exports, which the notes do not say",
          };
        case "wrong_entity":
          return {
            text: s({ scope: "all paid plans" }),
            why: `rate limit applies to ${plan} plans only, not all paid plans`,
          };
        case "date_off_by_one": {
          const d = offByOne(ship, rr);
          return {
            text: s({ date: d }),
            why: `ship date ${longDate(ship)} given as ${longDate(d)}`,
          };
        }
        case "unit_slip":
          return {
            text: s({ unit: "second" }),
            why: "rate limit given per second; the notes say per minute",
          };
        case "format_violation":
          return {
            text: plain.replace(" [3], and Okta", " [3]. Okta"),
            why: "three sentences where exactly two were required",
          };
        case "fabricated_citation":
          return {
            text: s({ ssoRef: "[5]" }),
            why: "single sign-on fact cited to paragraph [5], which does not exist",
          };
        case "negation":
          return {
            text: s({ sso: "is in beta and now available on the Starter plan" }),
            why: "SSO is not available on Starter; the output says it is",
          };
      }
    };
    return { task: { request, sources: [{ name: "release_notes", text: notes }] }, render };
  },
};

export const summaryFamilies: readonly Family[] = [meeting, incident, release];
