/**
 * Small code diffs against a written requirement. The application holds the ticket and the
 * original file; the proposer returns a commit message and a unified diff; the verifier checks
 * that the diff does what the ticket asks, nothing more, and that the message cites the ticket.
 */
import type { Rand } from "../../../../src/math.ts";
import { int, pickOne } from "../pools.ts";
import type { Candidate, ErrorType, Family, Variant } from "../types.ts";

const VALIDATORS = [
  { fn: "parse_port", noun: "port", lo: 1, hi: 65535, file: "config/parse.py" },
  { fn: "parse_percent", noun: "percent", lo: 0, hi: 100, file: "billing/inputs.py" },
  { fn: "parse_retry_count", noun: "retry count", lo: 0, hi: 10, file: "jobs/options.py" },
  { fn: "parse_page_size", noun: "page size", lo: 1, hi: 500, file: "api/query.py" },
  { fn: "parse_priority", noun: "priority", lo: 1, hi: 5, file: "tickets/fields.py" },
  { fn: "parse_quantity", noun: "quantity", lo: 1, hi: 999, file: "orders/forms.py" },
] as const;

const SIBLINGS = ["parse_host", "parse_name", "parse_label", "parse_region"] as const;

const commit = (title: string, ticket: number): string => `commit message: ${title} (#${ticket})`;

/** A ticket number with a distinct digit pair, so a transposed citation is a different number. */
const ticketNo = (r: Rand): number => {
  for (;;) {
    const n = int(r, 120, 989);
    const s = String(n);
    if (s[1] !== s[2]) return n;
  }
};
const transposeTicket = (n: number): number => {
  const s = String(n);
  return Number(`${s[0]}${s[2]}${s[1]}`);
};

const VALIDATION_ERRORS: readonly ErrorType[] = [
  "wrong_number",
  "missing_requirement",
  "unsupported_claim",
  "wrong_entity",
  "format_violation",
  "fabricated_citation",
  "negation",
];

const validation: Family = {
  id: "code.validation",
  domain: "code",
  split: "fit",
  errors: VALIDATION_ERRORS,
  make(r) {
    const v = pickOne(r, VALIDATORS);
    const sib = pickOne(r, SIBLINGS);
    const ticket = ticketNo(r);
    const varName = v.noun
      .replace(/ /g, "_")
      .replace("retry_count", "count")
      .replace("page_size", "size");
    const original = [
      `# ${v.file}`,
      `def ${sib}(value: str) -> str:`,
      "    text = value.strip()",
      "    if not text:",
      `        raise ValueError("${sib.replace("parse_", "")} is empty")`,
      "    return text",
      "",
      "",
      `def ${v.fn}(value: str) -> int:`,
      `    ${varName} = int(value)`,
      `    return ${varName}`,
    ].join("\n");
    const message = `${v.noun} out of range: {${varName}}`;
    const request =
      `Ticket #${ticket}: change ${v.fn} so it raises ValueError(f"${message}") when the ${v.noun} ` +
      `is below ${v.lo} or above ${v.hi}. Keep the function signature unchanged, do not change any ` +
      "other function, and reference the ticket number in the commit message.";
    const diff = (body: readonly string[], extra: readonly string[] = []): string =>
      [
        `--- a/${v.file}`,
        `+++ b/${v.file}`,
        ...extra,
        `@@ def ${v.fn}(value: str) -> int:`,
        `     ${varName} = int(value)`,
        ...body,
        `     return ${varName}`,
      ].join("\n");
    const check = (cond: string, exc = "ValueError", msg = message): string[] => [
      `+    if ${cond}:`,
      `+        raise ${exc}(f"${msg}")`,
    ];
    const good = `${varName} < ${v.lo} or ${varName} > ${v.hi}`;
    const title = `Validate ${v.noun} range`;
    const cand = (t: string, d: string): string => `${t}\n\n${d}`;
    const plain = cand(commit(title, ticket), diff(check(good)));
    const render = (variant: Variant, _rr: Rand): Candidate => {
      switch (variant) {
        case "plain":
          return {
            text: plain,
            why: "correct: both bounds, ValueError with the exact message, ticket cited",
          };
        case "benign":
          return {
            text: cand(
              commit(`${title}.`, ticket),
              diff(check(`${varName} < ${v.lo} or ${varName} > ${v.hi}`)),
            ),
            why: "correct: a trailing full stop in the commit title only",
          };
        case "paraphrase":
          return {
            text: cand(
              commit(`Reject out-of-range ${v.noun} values`, ticket),
              diff(check(`not ${v.lo} <= ${varName} <= ${v.hi}`)),
            ),
            why: "correct: the range test written as a chained comparison, same behaviour",
          };
        case "wrong_number":
          return {
            text: cand(
              commit(title, ticket),
              diff(check(`${varName} < ${v.lo} or ${varName} > ${v.hi + 1}`)),
            ),
            why: `upper bound ${v.hi + 1}; the ticket says above ${v.hi}`,
          };
        case "missing_requirement":
          return {
            text: cand(commit(title, ticket), diff(check(`${varName} > ${v.hi}`))),
            why: `only the upper bound is checked; values below ${v.lo} pass`,
          };
        case "unsupported_claim":
          return {
            text: cand(
              commit(title, ticket),
              diff(check(good), [
                `@@ def ${sib}(value: str) -> str:`,
                "-    text = value.strip()",
                "+    text = value.strip().lower()",
              ]),
            ),
            why: `also changes ${sib}, which the ticket forbids`,
          };
        case "wrong_entity":
          return {
            text: cand(commit(title, ticket), diff(check(good, "TypeError"))),
            why: "raises TypeError where ValueError was required",
          };
        case "format_violation":
          return {
            text: cand(commit(title, ticket), diff(check(good, "ValueError", `invalid ${v.noun}`))),
            why: `error message "invalid ${v.noun}" instead of the required "${message}"`,
          };
        case "fabricated_citation": {
          const bad = transposeTicket(ticket);
          return {
            text: cand(commit(title, bad), diff(check(good))),
            why: `commit message cites #${bad}; the ticket is #${ticket}`,
          };
        }
        case "negation":
          return {
            text: cand(commit(title, ticket), diff(check(`${v.lo} <= ${varName} <= ${v.hi}`))),
            why: "condition inverted: raises for in-range values and accepts out-of-range ones",
          };
        default:
          throw new Error(`code.validation cannot render ${variant}`);
      }
    };
    return {
      task: { request, sources: [{ name: "original_file", text: original }] },
      render: (variant, rr) => render(variant, rr),
    };
  },
};

const EXPIRY_ERRORS: readonly ErrorType[] = [
  "missing_requirement",
  "unsupported_claim",
  "wrong_entity",
  "date_off_by_one",
  "unit_slip",
  "format_violation",
  "fabricated_citation",
  "negation",
];

const SUBJECTS = [
  {
    thing: "session tokens",
    cls: "Token",
    make: "issue_token",
    check: "is_expired",
    file: "auth/tokens.py",
  },
  {
    thing: "password reset links",
    cls: "ResetLink",
    make: "create_reset_link",
    check: "link_expired",
    file: "auth/reset.py",
  },
  {
    thing: "invitation codes",
    cls: "Invite",
    make: "create_invite",
    check: "invite_expired",
    file: "teams/invites.py",
  },
  {
    thing: "download links",
    cls: "DownloadLink",
    make: "sign_download",
    check: "download_expired",
    file: "files/links.py",
  },
] as const;

const expiry: Family = {
  id: "code.expiry",
  domain: "code",
  split: "heldout",
  errors: EXPIRY_ERRORS,
  make(r) {
    const s = pickOne(r, SUBJECTS);
    const days = pickOne(r, [7, 14, 30, 90]);
    const ticket = ticketNo(r);
    const original = [
      `# ${s.file}`,
      "from datetime import datetime, timedelta, timezone",
      "",
      "",
      `def ${s.make}(owner_id: str) -> ${s.cls}:`,
      "    now = datetime.now(timezone.utc)",
      `    return ${s.cls}(owner_id=owner_id, issued_at=now, expires_at=None)`,
      "",
      "",
      `def ${s.check}(item: ${s.cls}, now: datetime) -> bool:`,
      "    return False",
    ].join("\n");
    const request =
      `Ticket #${ticket}: make ${s.thing} expire ${days} days after they are issued. Set expires_at ` +
      `in ${s.make} using timedelta, and make ${s.check} return True once now is at or after ` +
      "expires_at. Change nothing else, and reference the ticket number in the commit message.";
    const diff = (expires: string, cmp: string | null, extra: readonly string[] = []): string =>
      [
        `--- a/${s.file}`,
        `+++ b/${s.file}`,
        `@@ def ${s.make}(owner_id: str) -> ${s.cls}:`,
        "     now = datetime.now(timezone.utc)",
        ...extra,
        `-    return ${s.cls}(owner_id=owner_id, issued_at=now, expires_at=None)`,
        `+    return ${s.cls}(owner_id=owner_id, issued_at=now, expires_at=${expires})`,
        ...(cmp === null
          ? []
          : [
              `@@ def ${s.check}(item: ${s.cls}, now: datetime) -> bool:`,
              "-    return False",
              `+    return ${cmp}`,
            ]),
      ].join("\n");
    const goodExp = `now + timedelta(days=${days})`;
    const goodCmp = "now >= item.expires_at";
    const title = `Expire ${s.thing} after ${days} days`;
    const cand = (t: string, d: string): string => `${t}\n\n${d}`;
    const plain = cand(commit(title, ticket), diff(goodExp, goodCmp));
    const render = (variant: Variant, rr: Rand): Candidate => {
      switch (variant) {
        case "plain":
          return {
            text: plain,
            why: "correct: timedelta of the right days, at-or-after comparison, ticket cited",
          };
        case "benign":
          return {
            text: cand(commit(title.toLowerCase(), ticket), diff(goodExp, goodCmp)),
            why: "correct: commit title in lower case only",
          };
        case "paraphrase":
          return {
            text: cand(
              commit(`Add ${days}-day expiry to ${s.thing}`, ticket),
              diff(goodExp, "item.expires_at <= now"),
            ),
            why: "correct: comparison written the other way round, same behaviour",
          };
        case "missing_requirement":
          return {
            text: cand(commit(title, ticket), diff(goodExp, null)),
            why: `sets expires_at but leaves ${s.check} always returning False`,
          };
        case "unsupported_claim":
          return {
            text: cand(
              commit(title, ticket),
              diff(goodExp, goodCmp, ['+    print(f"issued for {owner_id}")']),
            ),
            why: "adds a print statement the ticket did not ask for",
          };
        case "wrong_entity":
          return {
            text: cand(commit(title, ticket), diff(goodExp, "now >= item.issued_at")),
            why: "compares against issued_at instead of expires_at",
          };
        case "date_off_by_one": {
          const bad = days + (rr() < 0.5 ? -1 : 1);
          return {
            text: cand(commit(title, ticket), diff(`now + timedelta(days=${bad})`, goodCmp)),
            why: `expiry of ${bad} days; the ticket says ${days}`,
          };
        }
        case "unit_slip":
          return {
            text: cand(commit(title, ticket), diff(`now + timedelta(hours=${days})`, goodCmp)),
            why: `timedelta(hours=${days}): hours where days were required`,
          };
        case "format_violation":
          return {
            text: cand(
              commit(title, ticket),
              diff(
                `datetime.fromtimestamp(now.timestamp() + ${days * 86400}, timezone.utc)`,
                goodCmp,
              ),
            ),
            why: "computes the expiry by timestamp arithmetic; the ticket requires timedelta",
          };
        case "fabricated_citation": {
          const bad = transposeTicket(ticket);
          return {
            text: cand(commit(title, bad), diff(goodExp, goodCmp)),
            why: `commit message cites #${bad}; the ticket is #${ticket}`,
          };
        }
        case "negation":
          return {
            text: cand(commit(title, ticket), diff(goodExp, "now < item.expires_at")),
            why: "comparison inverted: reports unexpired items as expired",
          };
        default:
          throw new Error(`code.expiry cannot render ${variant}`);
      }
    };
    return { task: { request, sources: [{ name: "original_file", text: original }] }, render };
  },
};

const PAGINATION_ERRORS: readonly ErrorType[] = [
  "wrong_number",
  "missing_requirement",
  "unsupported_claim",
  "wrong_entity",
  "format_violation",
  "fabricated_citation",
  "negation",
];

const LISTS = [
  { fn: "list_invoices", coll: "invoices", file: "billing/views.py" },
  { fn: "list_members", coll: "members", file: "teams/views.py" },
  { fn: "list_events", coll: "events", file: "audit/views.py" },
] as const;

const pagination: Family = {
  id: "code.pagination",
  domain: "code",
  split: "challenge",
  errors: PAGINATION_ERRORS,
  make(r) {
    const l = pickOne(r, LISTS);
    const max = pickOne(r, [50, 100, 200]);
    const ticket = ticketNo(r);
    const original = [
      `# ${l.file}`,
      `def ${l.fn}(${l.coll}: list, page: int, page_size: int) -> list:`,
      `    return ${l.coll}`,
    ].join("\n");
    const request =
      `Ticket #${ticket}: paginate ${l.fn}. Pages are numbered from 1. Raise ValueError if page is ` +
      `below 1 or page_size is not between 1 and ${max} inclusive, then return only the requested ` +
      "page as a list, in the original order. Reference the ticket number in the commit message.";
    const body = (o: {
      readonly pageCheck?: string | null;
      readonly sizeCheck?: string;
      readonly start?: string;
      readonly ret?: string;
      readonly extra?: readonly string[];
    }): string =>
      [
        `--- a/${l.file}`,
        `+++ b/${l.file}`,
        `@@ def ${l.fn}(${l.coll}: list, page: int, page_size: int) -> list:`,
        `-    return ${l.coll}`,
        ...(o.pageCheck === null
          ? []
          : [
              `+    if ${o.pageCheck ?? "page < 1"}:`,
              '+        raise ValueError("page must be at least 1")',
            ]),
        `+    if ${o.sizeCheck ?? `not 1 <= page_size <= ${max}`}:`,
        `+        raise ValueError("page_size must be between 1 and ${max}")`,
        ...(o.extra ?? []),
        `+    start = ${o.start ?? "(page - 1) * page_size"}`,
        `+    return ${o.ret ?? `${l.coll}[start:start + page_size]`}`,
      ].join("\n");
    const title = `Paginate ${l.fn}`;
    const cand = (t: string, d: string): string => `${t}\n\n${d}`;
    const plain = cand(commit(title, ticket), body({}));
    const render = (variant: Variant, _rr: Rand): Candidate => {
      switch (variant) {
        case "plain":
          return {
            text: plain,
            why: "correct: 1-based pages, both checks, slice of one page, ticket cited",
          };
        case "benign":
          return {
            text: cand(commit(`${title}.`, ticket), body({})),
            why: "correct: a trailing full stop in the commit title only",
          };
        case "paraphrase":
          return {
            text: cand(
              commit(`Add pagination to ${l.fn}`, ticket),
              body({ sizeCheck: `page_size < 1 or page_size > ${max}` }),
            ),
            why: "correct: size check written as two comparisons, same behaviour",
          };
        case "wrong_number":
          return {
            text: cand(commit(title, ticket), body({ start: "page * page_size" })),
            why: "start index page * page_size skips the first page (pages are 1-based)",
          };
        case "missing_requirement":
          return {
            text: cand(commit(title, ticket), body({ pageCheck: null })),
            why: "the page < 1 check is missing",
          };
        case "unsupported_claim":
          return {
            text: cand(
              commit(title, ticket),
              body({ ret: `sorted(${l.coll})[start:start + page_size]` }),
            ),
            why: "sorts the list; the ticket requires the original order",
          };
        case "wrong_entity":
          return {
            text: cand(commit(title, ticket), body({ start: "(page - 1) * page" })),
            why: "start index multiplies by page instead of page_size",
          };
        case "format_violation":
          return {
            text: cand(
              commit(title, ticket),
              body({ ret: `tuple(${l.coll}[start:start + page_size])` }),
            ),
            why: "returns a tuple where a list was required",
          };
        case "fabricated_citation": {
          const bad = transposeTicket(ticket);
          return {
            text: cand(commit(title, bad), body({})),
            why: `commit message cites #${bad}; the ticket is #${ticket}`,
          };
        }
        case "negation":
          return {
            text: cand(commit(title, ticket), body({ sizeCheck: `1 <= page_size <= ${max}` })),
            why: "size check inverted: rejects valid page sizes",
          };
        default:
          throw new Error(`code.pagination cannot render ${variant}`);
      }
    };
    return { task: { request, sources: [{ name: "original_file", text: original }] }, render };
  },
};

export const codeFamilies: readonly Family[] = [validation, expiry, pagination];
