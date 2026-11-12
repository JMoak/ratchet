/**
 * What leaves the machine about one tool call: a scrubbed subject plus facts computed by this
 * code. Mirrors the keywork gate's contract. The agent wrote the command, path or arguments,
 * so they are untrusted spans; the facts (destructive, opaque, a check switched off, inside
 * the workspace, change size) are digests the floors can read. File contents, tool output and
 * the conversation are never kept: a write is its line count, an edit is lines removed and added.
 *
 * Scrubbing is best effort and documented as such. It removes the shapes secrets usually take
 * (credential headers, cookies and flags, `key=value`, JSON and environment assignments, URL
 * passwords and query keys, vendor token prefixes, long random blobs). It is not a guarantee,
 * which is why the dry run prints the exact text before anything is sent.
 *
 * The command digests are lists of named rules (`DESTRUCTIVE_COMMANDS`, `OPAQUE_COMMANDS`,
 * `CHECK_BYPASS_COMMANDS`, `UPLOAD_COMMANDS`, `HARNESS_CONFIG_COMMANDS`), each tested with
 * commands it must and must not match. They read the command after `normaliseCommand` has
 * joined continuation lines, turned Unicode dashes into `-` and dropped quotes around single
 * words. They are a digest, not a parser: a rule that misses a form lets the model judge it
 * unaided, and a rule that over-matches only sends a call to review.
 */
import { posix, win32 } from "node:path";

export type Change =
  | { readonly kind: "write"; readonly lines: number }
  | {
      readonly kind: "edit";
      readonly removedLines: number;
      readonly addedLines: number;
      readonly replaceAll: boolean;
    }
  | {
      readonly kind: "patch";
      readonly files: number;
      readonly addedLines: number;
      readonly removedLines: number;
      readonly deletes: number;
    };

export type Subject =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly parts: number;
      readonly destructive: boolean;
      readonly opaque: boolean;
      /** A check switched off (hooks, tests, linters, TLS, checksums). Absent on older subjects. */
      readonly checkBypass?: boolean;
      readonly uploads: boolean;
      /** Writes or links onto an agent harness's configuration. Absent on older subjects. */
      readonly harnessConfig?: boolean;
      /** Prints, copies or packs a credential file. Absent on older subjects. */
      readonly credential?: boolean;
      readonly truncated: boolean;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      /** Undefined when the harness gave no cwd to measure against. */
      readonly insideWorkspace?: boolean;
      /**
       * Under the harness's scratch space or its notes (`projects/<p>/memory/`): the only
       * harness-owned places, and never configuration. Absent on older subjects.
       */
      readonly harnessOwned?: boolean;
      /**
       * Agent harness configuration: settings, credentials, hooks, MCP servers, and anything
       * else under the harness's home that is not its notes. Absent on older subjects.
       */
      readonly harnessConfig?: boolean;
      /**
       * A credential file (`CREDENTIAL_SHAPES`; a `.env` only outside the workspace). Absent on
       * older subjects.
       */
      readonly credential?: boolean;
      readonly readOnly: boolean;
      readonly destructive: boolean;
      readonly change?: Change;
      /** Present, and true, only when the path (or a patch's file list) was cut. */
      readonly truncated?: true;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "url";
      readonly url: string;
      readonly truncated: boolean;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "query";
      readonly query: string;
      readonly truncated: boolean;
      /** Absent on subjects journalled before queries were scrubbed. */
      readonly redacted?: boolean;
    }
  | { readonly kind: "call"; readonly shape: string; readonly truncated: boolean };

export const COMMAND_MAX_CHARS = 1000;
export const PATH_MAX_CHARS = 1000;
export const URL_MAX_CHARS = 500;
export const QUERY_MAX_CHARS = 300;
export const SHAPE_MAX_CHARS = 600;
/** Files of an `apply_patch` placed one by one; a longer list is shown truncated. */
export const PATCH_MAX_PATHS = 200;

// ---------------------------------------------------------------------------------------------
// Secrets

/** One shape a secret takes. Group 1, when the pattern has one, is kept and the rest replaced. */
export interface SecretShape {
  readonly id: string;
  /** Global. */
  readonly pattern: RegExp;
}

/**
 * Named secret shapes, applied in order. Flags, keys and assignments keep their name and lose
 * their value, so the gate still sees that a credential was passed; prefixed tokens go whole.
 * Values are bounded scans, so a hostile window costs linear time.
 */
export const SECRET_SHAPES: readonly SecretShape[] = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  {
    id: "authorization-header",
    pattern: /(\bauthorization\s*[:=]\s*(?:bearer|basic|token|bot|digest)?\s*)[^\s"']+/gi,
  },
  { id: "cookie-header", pattern: /(\b(?:set-)?cookie\s*:\s*)[^"'\r\n]+/gi },
  {
    // curl -b / --cookie (only curl's and its kin's; `git checkout -b` names a branch).
    id: "cookie-flag",
    pattern:
      /(\b(?:curl|wget|xh|http|https)\b[^|;&\n]{0,2000}?\s(?:-b|--cookie)(?:=|\s+)["']?)[^\s"']+/g,
  },
  {
    // scheme://user:password@host: the user and the host stay. Before key-value, which would
    // take everything after `x-access-token:` up to the next space.
    id: "url-userinfo",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:)[^\s@/"']+(?=@)/gi,
  },
  {
    // ?key=, &token=, access_token=, sig=, X-Amz-Signature=: credentials in a query string.
    id: "url-query-secret",
    pattern:
      /([?&](?:key|api[_-]?key|apikey|token|access[_-]?token|auth[_-]?token|auth|sig|signature|secret|client[_-]?secret|password|passwd|pwd|code|private[_-]?token|session|sessionid|sid|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s"']+/gi,
  },
  {
    // {"token":"…"}, "password": "…", 'client_secret': '…': a quoted key ending in a secret word.
    id: "json-secret",
    pattern:
      /(["'][A-Za-z0-9_-]{0,64}?(?:token|password|passwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?)["']\s*:\s*["'])[^"']+/gi,
  },
  {
    id: "key-value",
    pattern:
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)\s*[=:]\s*["']?)[^\s"'&;]+/gi,
  },
  {
    // PGPASSWORD=, MYSQL_PWD=, DB_PASS=, GITHUB_TOKEN=, $env:API_KEY = ...: names ending in a
    // secret word.
    id: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASSPHRASE|_PASS|_PWD|TOKEN|SECRET|SECRET_KEY|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*["']?)[^\s"'&;]+/gi,
  },
  {
    // --password x, --token=x, --api-key x, --client-secret x; not --password-stdin, --token-file
    // or --no-password, and never a following flag or a redirect (`--with-token < file`).
    id: "secret-flag",
    pattern:
      /(--(?!no-)(?:[a-z0-9]+-)*(?:password|passwd|token|secret|api-?key|apikey|access-key|secret-key|private-key)(?:=|\s+)["']?)(?![-<>|&;])[^\s"']+/gi,
  },
  {
    // curl -u user:pass, --user user:pass: the user stays. Not `python -u C:\x` (a drive) or
    // `-u http://x`: the password never starts with a slash.
    id: "basic-auth-flag",
    pattern:
      /((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:=|\s*)["']?[^\s:"'\\/-][^\s:"'\\/]*:)(?![\\/])[^\s"']+/g,
  },
  {
    // sshpass -p pw, docker|podman|helm login -p pw.
    id: "password-short-flag",
    pattern:
      /(\b(?:sshpass|(?:docker|podman|nerdctl|buildah|helm|oras)(?:\s+registry)?\s+login)\b[^|;&\n]{0,2000}?\s-p(?:=|\s*)["']?)(?![-<>|])[^\s"']+/g,
  },
  {
    // mysql -pSECRET (the password attached to -p; a bare -p prompts).
    id: "mysql-password",
    pattern:
      /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^|;&\n]{0,2000}?\s-p)(?=\S)[^\s"']+/g,
  },
  {
    id: "aws-secret-argument",
    pattern: /(\baws_(?:secret_access_key|session_token)["']?(?:\s*[=:]\s*|\s+)["']?)[^\s"']+/gi,
  },
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    // sk-…, sk-proj-…, sk-or-v1-…, sk-ant-api03-…: a run of 16 or more letters and digits with a
    // digit in it, so a branch named `rk-fix-the-long-branch-name` is left alone.
    id: "openai-style-key",
    pattern:
      /\b(?:sk|rk|pk)-(?:[A-Za-z0-9_]{1,15}-){0,6}(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{16,}[A-Za-z0-9_-]*/g,
  },
  { id: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { id: "stripe-webhook-secret", pattern: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { id: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{40,}/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { id: "digitalocean-token", pattern: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { id: "shopify-token", pattern: /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  // No shape for bare hex: 40 and 64 hex digits are commit ids and content digests far more
  // often than credentials, and hex credentials are caught by the name they are passed under.
];

const BLOB = /[A-Za-z0-9+/\\_-]{20,}={0,2}/g;

const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;

/**
 * Does one path segment look like random data rather than a word, a slug or an id? At least 20
 * characters, three or more each of upper- and lower-case letters, a digit, and lower-case
 * runs averaging at most 2.5 letters. Words, CamelCase identifiers and paths have longer
 * lower-case runs; hex ids and UUIDs have no upper case. The old `[A-Za-z0-9+/]{40,}` shape
 * redacted 38 of 39 real long paths (e2e T1-09); this one was tuned so that only random ids trip
 * it, and misses a few percent of random 40-character base64 strings (172 of 5,000), so it backs
 * up the named shapes rather than replacing them.
 */
function randomLooking(s: string): boolean {
  if (s.length < 20 || count(s, /[A-Z]/g) < 3 || !/[0-9]/.test(s)) return false;
  const lower = s.match(/[a-z]+/g) ?? [];
  if (lower.reduce((n, r) => n + r.length, 0) < 3) return false;
  return lower.reduce((n, r) => n + r.length, 0) / lower.length <= 2.5;
}

const mixedClasses = (s: string): boolean => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

/**
 * Redact the random-looking segments of one run of base64-ish characters, keeping the path
 * around them. A run is split at slashes; a segment is redacted when it looks random on its
 * own, and the mixed-class segments are redacted together when only their concatenation does
 * (a base64 blob that happens to contain slashes).
 */
function redactBlob(run: string): string {
  const parts = run.split(/([\\/])/);
  const segments = parts.filter((_, i) => i % 2 === 0);
  if (segments.some(randomLooking)) {
    return parts.map((p, i) => (i % 2 === 0 && randomLooking(p) ? "[redacted]" : p)).join("");
  }
  const mixed = segments.filter(mixedClasses);
  if (mixed.length > 1 && randomLooking(mixed.join(""))) return "[redacted]";
  return run;
}

/** Replace the usual shapes of a secret. Returns the text and whether anything was replaced. */
export function scrub(text: string): { readonly text: string; readonly redacted: boolean } {
  let out = text;
  for (const { pattern } of SECRET_SHAPES) {
    out = out.replace(pattern, (m: string, keep?: unknown) => {
      if (typeof keep !== "string") return "[redacted]";
      // A value an earlier shape already redacted stays as it is, with what follows it.
      return m.startsWith("[redacted]", keep.length) ? m : `${keep}[redacted]`;
    });
  }
  out = out.replace(BLOB, redactBlob);
  return { text: out, redacted: out !== text };
}

function cap(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

/**
 * Characters scrubbed past the shown cap, so a secret that straddles the cut is still whole
 * when it is matched and its head is not shown.
 */
const SCRUB_MARGIN = 2000;

/** Scrub, then cap: only a window a little longer than what is shown is ever scanned. */
function scrubCapped(
  raw: string,
  max: number,
): { readonly text: string; readonly truncated: boolean; readonly redacted: boolean } {
  const windowed = raw.length > max + SCRUB_MARGIN;
  const scrubbed = scrub(windowed ? raw.slice(0, max + SCRUB_MARGIN) : raw);
  const capped = cap(scrubbed.text, max);
  return {
    text: capped.text,
    truncated: capped.truncated || windowed,
    redacted: scrubbed.redacted,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands

/** How a command's text is read: POSIX shells and cmd, or PowerShell (backtick is an escape there). */
export type Shell = "posix" | "powershell";

/** One named digest rule. Not global, so `test` carries no state between calls. */
export interface CommandRule {
  /** Stable name; the tests key their examples on it. */
  readonly id: string;
  readonly pattern: RegExp;
  /** The shells it applies to; every shell when absent. */
  readonly shells?: readonly Shell[];
  /**
   * Read the command with its quoted strings blanked, so a flag named inside a commit message
   * (`-m "ci: stop using --no-verify"`) is not taken for the flag itself.
   */
  readonly outsideQuotes?: true;
  /**
   * The same rule as `pattern` (a verb and a target in one command segment, in either order),
   * split so the digests can test it as two linear scans per segment. As one expression it
   * tries the target's alternation at every position after every verb: a megabyte of ` cp x`
   * took ten seconds. `pattern` stays the rule's full statement for anyone testing it directly.
   */
  readonly inSegment?: { readonly verb: RegExp; readonly target: RegExp };
}

/**
 * A command segment: up to the next pipe, list operator or line break, and at most 2,000
 * characters. The bound keeps every rule linear: unbounded, a command of 200,000 ` rd x`
 * repeats took over two minutes, each `rd` rescanning to the end of the segment. A flag more
 * than 2,000 characters from its command is missed, and such a command is shown truncated,
 * which the floors review anyway.
 */
const SEG = "[^|;&\\n]{0,2000}";

/**
 * `git`, however it is spelled (`git.exe`, a full path, quoted), with any global options before
 * the verb (`-C <dir>`, `-c k=v`, `--git-dir=…`, `--work-tree …`, `--no-pager`), and the space
 * before the verb. Every git rule starts with it, so `git -C ../x push --force` is a push.
 */
const GIT =
  "\\bgit(?:\\.exe)?[\"']?(?:\\s+(?:-[Cc]\\s*(?:\"[^\"]*\"|'[^']*'|\\S+)|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=\\S+|\\s+\\S+)|--[a-z][a-z-]*|-[pP])){0,8}\\s+";

/**
 * How much of a command the digests read. Past this the command is shown truncated (the shown
 * cap is far smaller) and the floors review it whatever the digests say.
 */
export const DIGEST_MAX_CHARS = 100_000;

const re = (source: string, flags = ""): RegExp =>
  new RegExp(source.replaceAll("@SEG@", SEG).replaceAll("@GIT@", GIT), flags);

/** Remove-Item and its aliases, as a command word. */
const REMOVE = "(?:\\bRemove-Item|(?:^|[\\s;|&(])(?:ri|rm|rmdir|rd|del|erase))\\b";

/**
 * Commands that delete, discard work, rewrite history, publish or deploy, or reshape a
 * machine: one-way doors. Plain `rm file` and `Remove-Item file` are not here (a recursive or
 * forced delete is); neither is anything that only reads.
 */
export const DESTRUCTIVE_COMMANDS: readonly CommandRule[] = [
  {
    // Flags right after `rm`, one of them carrying r or f. Written so each flag token is read
    // once: `(?:-[a-z]*[rf][a-z]*\s+)+` backtracks quadratically on one long flag.
    id: "rm-recursive-or-force",
    pattern:
      /\brm(?:\s+-[a-zA-Z]+)*?\s+-[a-zA-Z]*[rf]|\brm\s[^|;&\n]{0,2000}?--(?:recursive|force)\b/,
  },
  {
    id: "cmd-recursive-delete",
    pattern: re("\\b(?:rmdir|rd|del|erase)\\b@SEG@\\s\\/[sq]\\b", "i"),
  },
  {
    // Remove-Item and its aliases with -Recurse or -Force (any unambiguous prefix).
    id: "powershell-remove-item",
    pattern: re(`${REMOVE}@SEG@\\s-(?:r[a-z]*|fo[a-z]*)\\b`, "i"),
  },
  {
    // `$p = @{ Recurse = $true }; Remove-Item x @p`: the switches arrive in a splatted table.
    id: "powershell-splatted-remove",
    pattern: re(
      `^(?=[\\s\\S]*\\b(?:Recurse|Force)\\s*=\\s*(?:\\$true|1)\\b)(?=[\\s\\S]*${REMOVE}@SEG@\\s@\\w)`,
      "i",
    ),
  },
  {
    id: "dotnet-delete",
    pattern: /\[(?:System\.)?IO\.(?:Directory|File)\]::Delete\b/i,
  },
  { id: "rimraf", pattern: /\brimraf\b/ },
  {
    id: "piped-delete",
    pattern: /\|\s*(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b/i,
  },
  { id: "find-delete", pattern: re("\\bfind\\b@SEG@\\s-delete\\b") },
  { id: "clear-content", pattern: /\b(?:Clear-Content|Clear-RecycleBin)\b/i },
  { id: "git-push", pattern: re("@GIT@push\\b") },
  { id: "git-reset-hard", pattern: re("@GIT@reset@SEG@\\s--hard\\b") },
  { id: "git-clean", pattern: re("@GIT@clean@SEG@\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\\b") },
  { id: "git-branch-force-delete", pattern: re("@GIT@branch@SEG@\\s-D\\b") },
  { id: "git-rewrite-history", pattern: re("@GIT@(?:filter-branch|filter-repo)\\b") },
  {
    // `git checkout -- <path>`, `git checkout .`, `git checkout -f`: uncommitted work is gone.
    id: "git-checkout-discard",
    pattern: re("@GIT@checkout@SEG@\\s(?:--(?=\\s|$)|\\.(?=\\s|$)|-f\\b|--force\\b)"),
  },
  {
    // `git restore <path>` restores the worktree unless only --staged is asked for.
    id: "git-restore-worktree",
    pattern: re("@GIT@restore\\b(?!@SEG@\\s(?:--staged|-S)(?=\\s|$))"),
  },
  {
    id: "git-restore-staged-and-worktree",
    pattern: re("@GIT@restore@SEG@\\s(?:--worktree|-W|-SW|-WS)(?=\\s|$)"),
  },
  { id: "git-stash-drop", pattern: re("@GIT@stash\\s+(?:drop|clear)\\b") },
  { id: "sql-drop", pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b/i },
  { id: "sql-delete", pattern: /\bDELETE\s+FROM\b/i },
  {
    id: "disk-format",
    pattern:
      /\b(?:mkfs|fdisk|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b|\bformat\s+[a-z]:/i,
  },
  { id: "dd", pattern: /\bdd\s+if=/ },
  { id: "write-raw-device", pattern: />\s*\/dev\/(?:sd|nvme|disk)/ },
  {
    id: "power",
    pattern: /\b(?:shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i,
  },
  {
    id: "elevate",
    pattern: re("\\bStart-Process@SEG@-Verb\\s+[\"']?RunAs\\b|\\brunas\\s+\\/", "i"),
  },
  { id: "execution-policy", pattern: /\bSet-ExecutionPolicy\b/i },
  {
    id: "registry-write",
    pattern: re(
      "\\b(?:Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Rename-ItemProperty|Set-Item|New-Item|Remove-Item)\\b@SEG@\\b(?:HK(?:LM|CU|CR|U|CC)(?::|\\\\)|HKEY_[A-Z_]+|Registry::)|\\breg(?:\\.exe)?\\s+(?:add|delete|import|restore|load|unload|copy)\\b",
      "i",
    ),
  },
  {
    id: "security-off",
    pattern: re(
      "\\bSet-MpPreference@SEG@-Disable|\\bnetsh\\s+advfirewall@SEG@\\bstate\\s+off\\b",
      "i",
    ),
  },
  { id: "chmod-777", pattern: /\bchmod\s+(?:-R\s+)?[0-7]*777\b/ },
  {
    id: "grant-everyone",
    pattern: re("\\bicacls@SEG@\\/grant\\s+[\"']?(?:Everyone|\\*S-1-1-0)\\b", "i"),
  },
  { id: "kubectl-delete", pattern: /\bkubectl\s+(?:delete|drain)\b/ },
  { id: "terraform-apply-or-destroy", pattern: /\b(?:terraform|tofu)\s+(?:destroy|apply)\b/ },
  {
    id: "docker-remove",
    pattern:
      /\bdocker\s+(?:(?:system|volume|image|container|network|builder|buildx)\s+prune|rm|rmi|volume\s+rm)\b/,
  },
  {
    // Only global flags sit between `compose` and `down`; a short gap keeps the rule linear.
    id: "docker-compose-down-volumes",
    pattern: re(
      "\\bdocker(?:-compose|\\s+compose)\\b[^|;&\\n]{0,200}?\\bdown\\b@SEG@\\s(?:-v|--volumes)\\b",
    ),
  },
  {
    id: "publish-js",
    pattern: /\b(?:npm|bun|pnpm|yarn|lerna|changeset|vsce|ovsx|deno|jsr)\s+publish\b/,
  },
  { id: "publish-rust", pattern: /\bcargo\s+publish\b/ },
  {
    id: "publish-python",
    pattern: /\btwine\s+upload\b|\b(?:uv|poetry|flit|hatch|pdm)\s+publish\b/,
  },
  {
    id: "publish-package",
    pattern: re(
      "\\bgem\\s+push\\b|\\b(?:dotnet\\s+nuget|nuget)\\s+push\\b|\\bmvn@SEG@\\s(?:deploy|release:perform)\\b|\\b(?:gradle|gradlew)@SEG@\\spublish(?!ToMavenLocal)\\w*\\b|\\b(?:docker|podman|helm)\\s+push\\b",
    ),
  },
  {
    id: "github-release",
    pattern: /\bgh\s+(?:release\s+(?:create|upload)|pr\s+merge|repo\s+delete)\b/,
  },
  {
    id: "deploy",
    pattern: re(
      "\\bmkdocs\\s+gh-deploy\\b|\\bgh-pages\\s+-d\\b|\\bvercel@SEG@\\s--prod(?:uction)?\\b|\\bnetlify\\s+deploy@SEG@\\s--prod\\b|\\bfirebase\\s+deploy\\b|\\b(?:fly|flyctl)\\s+deploy\\b|\\bwrangler\\s+(?:deploy|publish)\\b|\\b(?:serverless|sls)\\s+deploy\\b|\\bcdk\\s+(?:deploy|destroy)\\b|\\bpulumi\\s+(?:up|destroy)\\b",
    ),
  },
  {
    id: "cloud-delete",
    pattern: re(
      "\\baws\\s+s3\\s+(?:rm|rb)\\b|\\baws\\s+s3\\s+sync@SEG@\\s--delete\\b|\\baws\\s+[\\w-]+\\s+(?:delete|terminate|remove|purge|deregister)-[\\w-]+|\\bgsutil\\s+(?:-m\\s+)?(?:rm|rb)\\b|\\b(?:gcloud|az)\\b@SEG@\\s(?:delete|purge)\\b",
    ),
  },
  { id: "rsync-delete", pattern: re("\\brsync\\b@SEG@\\s--delete(?:-[\\w-]+)?\\b") },
];

/** Commands whose effect the model cannot read from the text: code built, decoded or fetched at run time. */
export const OPAQUE_COMMANDS: readonly CommandRule[] = [
  { id: "eval", pattern: /\beval\b/ },
  { id: "command-substitution", pattern: /\$\(/ },
  { id: "backticks", pattern: /`[^`]+`/, shells: ["posix"] },
  {
    id: "pipe-to-interpreter",
    pattern:
      /\|\s*(?:sh|bash|zsh|fish|pwsh|powershell|cmd|python[0-9.]*|node|perl|ruby|Invoke-Expression|iex)\b/i,
  },
  { id: "base64-decode", pattern: /\bbase64\s+(?:-d|--decode)\b|FromBase64String\b/i },
  {
    id: "download-and-run",
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|iwr|irm|Invoke-RestMethod)\b[^|]{0,2000}\|\s*(?:sh|bash|iex)\b/i,
  },
  { id: "invoke-expression", pattern: /\b(?:Invoke-Expression|iex)\b/i },
  {
    // -EncodedCommand and its prefixes, also inside `Start-Process … -ArgumentList '-enc …'`.
    id: "powershell-encoded-command",
    pattern: re(
      "\\b(?:powershell|pwsh)(?:\\.exe)?\\b@SEG@[\\s\"',]-(?:e|ec|en|enc\\w*)[\\s\"',]",
      "i",
    ),
  },
  { id: "scriptblock-create", pattern: /\[scriptblock\]::Create\b/i },
];

/**
 * Commands that switch off a check: commit hooks, tests and linters skipped, snapshots
 * rewritten to match, signatures, checksums and TLS not verified, packages from a source the
 * text does not vouch for, and secrets dumped from the environment. Each looks routine and each
 * hides what the check would have caught; on 241 fresh calls every one of Jev's 9 wrong acts was
 * one of these, which is a floor's job, not the model's.
 */
export const CHECK_BYPASS_COMMANDS: readonly CommandRule[] = [
  { id: "no-verify", pattern: /\s--no-verify\b/, outsideQuotes: true },
  {
    id: "git-commit-no-verify-short",
    pattern: re("@GIT@commit@SEG@\\s-[a-zA-Z]*n[a-zA-Z]*\\b"),
    outsideQuotes: true,
  },
  {
    // Husky, lefthook, overcommit and pre-commit switched off, or git's hooks pointed elsewhere.
    id: "hooks-off",
    pattern:
      /\bHUSKY\s*=\s*["']?0\b|\bHUSKY_SKIP_HOOKS\s*=\s*["']?(?:1|true)\b|\bLEFTHOOK\s*=\s*["']?(?:0|false)\b|\bOVERCOMMIT_DISABLE\s*=\s*["']?(?:1|true)\b|\bPRE_COMMIT_ALLOW_NO_CONFIG\s*=|\bSKIP=[\w,-]+\s|\bcore\.hooks[Pp]ath(?:\s*=|\s+\S)/,
  },
  { id: "signing-off", pattern: /--no-gpg-sign\b|\bcommit\.gpgsign=false\b/ },
  {
    id: "gradle-skip-task",
    pattern: re(
      "\\b(?:gradle|gradlew)\\b@SEG@\\s(?:-x|--exclude-task)(?:\\s+|=)[\"']?:?[\\w:-]*(?:test|lint|check|detekt|ktlint|spotless|checkstyle|pmd|spotbugs)\\w*",
      "i",
    ),
  },
  {
    id: "gradle-dependency-verification-off",
    pattern: /--dependency-verification(?:=|\s+)(?:off|lenient)\b/,
  },
  {
    // Any `-D<property>` naming a skip or an ignore, set (or left) true, in any case and with a
    // space after `-D`: -DskipTests, -Dmaven.test.skip.exec=true,
    // -Dmaven.test.failure.ignore=true, -Dspotless.check.skip=TRUE; and the insecure transport.
    id: "maven-skip",
    pattern:
      /(?:^|\s)-D\s?[\w.-]*(?:skip|ignore)[\w.-]*(?:=["']?(?:true|1|yes)\b|(?=[\s"']|$))|(?:^|\s)-D\s?maven\.wagon\.http\.ssl\.(?:insecure|allowall|ignore\.validity\.dates)(?:=["']?(?:true|1)\b|(?=[\s"']|$))/i,
  },
  {
    id: "dotnet-analysis-off",
    pattern:
      /[-/]p(?:roperty)?:(?:TreatWarningsAsErrors|RunAnalyzers|RunAnalyzersDuringBuild|EnforceCodeStyleInBuild|RunCodeAnalysis)=false\b/i,
  },
  {
    id: "static-analysis-baseline",
    pattern:
      /\bphpstan\b[^|;&\n]{0,2000}--generate-baseline\b|\bpsalm\b[^|;&\n]{0,2000}--(?:set|update)-baseline\b/,
  },
  {
    // Rewriting snapshots to match: the long flags anywhere; `-u` only on a test runner (not
    // `python -u`, which is unbuffered output).
    id: "update-snapshots",
    pattern: re(
      "--update-?[sS]napshots?\\b|--snapshot-update\\b|\\b(?:SNAPSHOT_TESTING_RECORD=all|UPDATE_SNAPSHOTS?=(?:1|true)|INSTA_UPDATE=(?:always|1))\\b|\\b(?:jest|vitest|nx|playwright|ng\\s+test|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test)\\b@SEG@\\s-u\\b",
    ),
  },
  {
    // Environment switches in any shell's spelling ($env:X = "0" included), and the flags.
    id: "tls-off",
    pattern:
      /\bGIT_SSL_NO_VERIFY\s*=\s*["']?(?!0\b|false\b)|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0\b|\bPYTHONHTTPSVERIFY\s*=\s*["']?0\b|\bhttp\.sslVerify(?:\s*=\s*|\s+)["']?false\b|\bstrict-ssl(?:\s*=\s*|\s+)["']?false\b|--no-check-certificate\b|-SkipCertificateCheck\b/i,
  },
  {
    // curl -k, --insecure, or -k inside a cluster of short flags (-fsSLk).
    id: "curl-insecure",
    pattern: re("\\bcurl\\b@SEG@\\s(?:--insecure|-[a-zA-Z]*k[a-zA-Z]*)\\b"),
  },
  {
    id: "checksums-off",
    pattern: /\bGO(?:NOSUMDB|NOSUMCHECK|INSECURE)=|\bGOSUMDB=off\b|\bGOFLAGS=\S*-insecure\b/,
  },
  {
    id: "untrusted-package-source",
    pattern:
      /--(?:registry|index-url|extra-index-url|index)(?:=|\s+)["']?http:\/\/|--trusted-host\b/,
  },
  {
    // The environment (where secrets live) dumped and sent on: a container's, or this shell's,
    // written to a file or piped on. Piped into a filter (`env | grep NODE_ENV`) it is a read of
    // one variable, not a dump.
    id: "env-dump",
    pattern: re(
      "\\bdocker\\s+(?:container\\s+)?inspect\\b[^;&\\n]{0,2000}Config\\.Env\\b|(?:^|[\\s;&|(])(?:printenv|env|(?:Get-ChildItem|gci|dir|ls)\\s+env:)\\s*(?:>|\\|(?!\\s*(?:grep|egrep|fgrep|rg|findstr|Select-String|sls|wc)\\b))",
      "i",
    ),
  },
];

/** Commands that send data somewhere else. */
export const UPLOAD_COMMANDS: readonly CommandRule[] = [
  {
    // A remote target, `host:path` or `user@host:path`; a drive letter or a URL is not one.
    id: "scp-rsync-remote",
    pattern: re("\\b(?:scp|rsync)\\b@SEG@\\s(?:\\S+@)?[A-Za-z0-9][\\w.-]+:(?!\\/\\/)"),
  },
  {
    id: "curl-send",
    pattern: re(
      "\\bcurl\\b@SEG@\\s(?:-d|--data(?:-\\w+)?|-F|--form|-T|--upload-file|-X\\s*[\"']?(?:POST|PUT|PATCH|post|put|patch)|--request(?:=|\\s+)[\"']?(?:POST|PUT|PATCH|post|put|patch))\\b",
    ),
  },
  { id: "wget-post", pattern: re("\\bwget\\b@SEG@--post-(?:data|file)\\b") },
  {
    // A local source (the first argument after at most 20 flags) copied to s3://; a download
    // is not.
    id: "aws-s3-upload",
    pattern: re(
      "\\baws\\s+s3\\s+(?:cp|sync|mv)\\s+(?:-\\S+\\s+){0,20}(?!s3:\\/\\/)\\S+@SEG@\\ss3:\\/\\/",
    ),
  },
  { id: "gcs-upload", pattern: /\b(?:gsutil|gcloud\s+storage)\s+(?:cp|rsync)\b/ },
  {
    // -Method Post / -Method:Post, -InFile, or a -Body at all.
    id: "powershell-send",
    pattern: re(
      "\\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\\b@SEG@(?:-Method(?::|\\s+)[\"']?(?:Post|Put|Patch)\\b|-InFile\\b|\\s-Body\\b)",
      "i",
    ),
  },
  { id: "gist-create", pattern: /\bgh\s+gist\s+create\b/ },
  { id: "azure-upload", pattern: /\bazcopy\s+(?:copy|cp|sync)\b|\baz\s+storage\s+blob\s+upload/ },
];

/**
 * A harness configuration file or tree, as a command names it: the same set the path side
 * matches (`HARNESS_CONFIG_SHAPES`): settings, credentials, hooks, MCP servers, the agent's own
 * agents, commands, skills, plugins and output styles, its instructions (`.claude/CLAUDE.md`,
 * `.codex/AGENTS.md`), and Codex's rules and prompts. Commands cannot be resolved against a
 * home, so these count wherever they are, as they do for paths.
 */
const CONFIG_TOKEN =
  "(?:\\.claude[\\\\/](?:settings(?:\\.local)?\\.json|managed-settings\\.json|\\.credentials\\.json|CLAUDE\\.md|(?:hooks|agents|commands|skills|plugins|output-styles)(?:[\\\\/]|\\b))|\\.claude\\.json|\\.mcp\\.json|\\.codex[\\\\/](?:config\\.toml|auth\\.json|hooks\\.json|AGENTS\\.md|(?:rules|prompts|agents|skills)(?:[\\\\/]|\\b)))";

/** A harness home itself (`.claude`, `.codex`) or anything in it, as a command names it. */
const HOME_TOKEN = `(?:\\.(?:claude|codex)(?=$|[\\s"'\\\\/;&|)])|${CONFIG_TOKEN})`;

/** A rule that holds when `verb` and `target` both appear in one command segment. */
function verbAndTarget(id: string, verb: string, target: string): CommandRule {
  return {
    id,
    pattern: re(`(?:${verb})@SEG@(?:${target})|(?:${target})@SEG@(?:${verb})`, "i"),
    inSegment: { verb: new RegExp(verb, "i"), target: new RegExp(target, "i") },
  };
}

const LINK_VERB = "-ItemType\\s+[\"']?(?:Junction|SymbolicLink|HardLink)\\b|\\bmklink\\b|\\bln\\b";
const WRITE_VERB =
  "\\b(?:cp|mv|install|ln|rsync|scp|tee|copy|move|xcopy|robocopy|Copy-Item|Move-Item|cpi|mi|Set-Content|Add-Content|Out-File|sc|ac|New-Item|ni|Rename-Item|rni|sed\\s+-i|perl\\s+-pi)\\b";

/** Commands that copy, move, write, redirect or link onto an agent harness's configuration. */
export const HARNESS_CONFIG_COMMANDS: readonly CommandRule[] = [
  // A junction, symbolic or hard link that names a harness home or its files: a path that later
  // looks like the workspace (or like the harness's notes) would reach configuration.
  verbAndTarget("link-to-harness-home", LINK_VERB, HOME_TOKEN),
  verbAndTarget("command-writes-harness-config", WRITE_VERB, CONFIG_TOKEN),
  {
    id: "redirect-onto-harness-config",
    pattern: re(`>{1,2}\\s*["']?[^\\s"'|;&<>]{0,500}${CONFIG_TOKEN}`, "i"),
  },
];

/**
 * A credential file, as a command names it: the same set the path side matches
 * (`CREDENTIAL_SHAPES`). A `.env` counts when the command reaches it outside the workspace (by
 * an absolute, home or parent path), as on the path side; `./.env` and `.env` are the
 * project's own.
 */
const CREDENTIAL_TOKEN =
  "(?:\\.ssh[\\\\/](?:id_[\\w.-]*(?<!\\.pub)|identity)(?![\\w.-])|[\\w-]\\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)(?![\\w.-])|\\.aws[\\\\/]credentials\\b|[._]netrc\\b|\\.npmrc\\b|\\.pypirc\\b|\\.git-credentials\\b|\\.docker[\\\\/]config\\.json\\b|\\.kube[\\\\/]config\\b|\\.claude[\\\\/]\\.credentials\\.json\\b|\\.codex[\\\\/]auth\\.json\\b|\\.config[\\\\/]gh[\\\\/]hosts\\.yml\\b|\\.gnupg[\\\\/]|[\\\\/]\\.env(?<=(?:^|[\\s\"'=(])(?:~|\\$\\{?HOME\\}?|\\$env:USERPROFILE|%USERPROFILE%|\\.\\.|[A-Za-z]:)?(?:[\\\\/][^\\s\"'|;&<>]{0,300})?[\\\\/]\\.env)(?:\\.(?!example|sample|template|dist)[\\w-]+)?(?![\\w.-]))";

/** Commands that print, copy or pack a credential file: the Read tool's shapes, by command. */
export const CREDENTIAL_COMMANDS: readonly CommandRule[] = [
  verbAndTarget(
    "reads-credential-file",
    "\\b(?:cat|type|Get-Content|gc|less|more|head|tail|bat|nl|od|xxd|hexdump|strings|base64|certutil|cp|copy|Copy-Item|cpi|scp|rsync|tar|zip|7z|Compress-Archive|grep|findstr|Select-String|sls)\\b",
    CREDENTIAL_TOKEN,
  ),
];

/**
 * A command as the rules read it: as written and normalised (a rule matches if it matches
 * either, so normalising can only add matches, never remove one), and, for the rules that ask,
 * the same two with their quoted strings blanked.
 */
interface Views {
  readonly raw: string;
  readonly norm: string;
  masked?: readonly [string, string];
}

/** A quoted string, bounded so a hostile quote costs linear time. */
const QUOTED = /"(?:[^"\\\n]|\\.){0,2000}"|'[^'\n]{0,2000}'/g;

const viewsOf = (command: string): Views => ({ raw: command, norm: normaliseCommand(command) });

const SEGMENT_BREAK = /[|;&\n]/;

/** One rule on one text: its pattern, or (the same rule, faster) its verb and target per segment. */
function ruleTest(r: CommandRule, text: string): boolean {
  const split = r.inSegment;
  if (split === undefined) return r.pattern.test(text);
  const { verb, target } = split;
  if (!verb.test(text) || !target.test(text)) return false;
  return text.split(SEGMENT_BREAK).some((seg) => verb.test(seg) && target.test(seg));
}

function ruleMatches(r: CommandRule, v: Views, shell: Shell): boolean {
  if (r.shells !== undefined && !r.shells.includes(shell)) return false;
  if (r.outsideQuotes) {
    v.masked ??= [v.raw.replace(QUOTED, '""'), v.norm.replace(QUOTED, '""')];
    return v.masked.some((t) => ruleTest(r, t));
  }
  return ruleTest(r, v.norm) || ruleTest(r, v.raw);
}

/** The ids of the rules that match a command, in list order. */
export function matchingRules(
  rules: readonly CommandRule[],
  command: string,
  shell: Shell = "posix",
): string[] {
  const v = viewsOf(command);
  return rules.filter((r) => ruleMatches(r, v, shell)).map((r) => r.id);
}

/**
 * The text the digests read: line continuations (`\` and PowerShell's backtick before a line
 * break) joined, Unicode hyphens and dashes (U+2010 to U+2015, U+2212; PowerShell takes the
 * dashes as `-`) made `-`, empty quotes inside a word dropped (`r""m`), and quotes around a
 * single word dropped (`"rm" -rf`, `'-Recurse'`). Never shown to anyone; the shown text is the
 * scrubbed original.
 */
export function normaliseCommand(command: string): string {
  return command
    .replace(/(?:\\|`)\r?\n/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/(?<=[\w-])(?:""|'')(?=[\w-])/g, "")
    .replace(/(["'])([\w./\\:@~+=,-]*)\1/g, "$2");
}

const any = (rules: readonly CommandRule[], v: Views, shell: Shell): boolean =>
  rules.some((r) => ruleMatches(r, v, shell));

/** Pipeline and list operators, counted roughly: a digest, not a parser. */
const countParts = (command: string): number =>
  1 + (command.match(/\s(?:&&|\|\||\||;)\s/g)?.length ?? 0);

/** Claude Code's `Bash` and `PowerShell`; Codex's `shell` (an argv) and `exec_command` (a string). */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell", "shell", "exec_command"]);

const POWERSHELL = /^(?:.*[\\/])?(?:powershell|pwsh)(?:\.exe)?$/i;

/** The command text and the shell it is read in. An argv is joined, quoting what has spaces. */
function commandOf(
  tool: string,
  input: Record<string, unknown>,
): { readonly text: string; readonly shell: Shell } {
  const raw = input.command ?? input.cmd;
  if (Array.isArray(raw)) {
    const argv = raw.filter((a): a is string => typeof a === "string");
    const text = argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
    return { text, shell: POWERSHELL.test(argv[0] ?? "") ? "powershell" : "posix" };
  }
  const text = typeof raw === "string" ? raw : "";
  const declared = str(input, "shell") ?? "";
  return {
    text,
    shell: tool === "PowerShell" || POWERSHELL.test(declared) ? "powershell" : "posix",
  };
}

// ---------------------------------------------------------------------------------------------
// Paths

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const PATH_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

const str = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
};

const lines = (text: string): number => (text === "" ? 0 : text.split(/\r\n|\r|\n/).length);

const windowsVolume = /^(?:[a-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;

/** Where a path is measured from. Every field is optional; what is missing is not guessed. */
export interface Placement {
  /** The call's working directory: what a relative path resolves against. */
  readonly cwd?: string;
  /**
   * The session's root: what "inside the workspace" means. The project directory the harness
   * reports, else the session's first known cwd. Default: `cwd`, which follows the agent's `cd`.
   */
  readonly root?: string;
  /** The user's home, for a leading `~`. */
  readonly home?: string;
  /**
   * Agent harness homes (`~/.claude`, `~/.codex`): everything under one is harness
   * configuration (settings, hooks, plugins, skills, agents, commands, global instructions),
   * except Claude Code's notes, `projects/<p>/memory/`.
   */
  readonly harnessHomes?: readonly string[];
  /** The harness's scratch space (`<tmp>/claude`): harness-owned, never configuration. */
  readonly harnessScratch?: readonly string[];
}

function pathsFor(...probes: (string | undefined)[]): typeof posix {
  return probes.some((p) => p !== undefined && windowsVolume.test(p)) ? win32 : posix;
}

function expandHome(path: string, home: string | undefined): string {
  return home !== undefined && /^~(?:[\\/]|$)/.test(path) ? `${home}${path.slice(1)}` : path;
}

/**
 * Spell a Windows path the way the file system will read it: no `\\?\` prefix, no alternate
 * data stream (`settings.json::$DATA`), no trailing dots or spaces on a name (`settings.json.`).
 * Doubled separators and `.`/`..` are left to `resolve`.
 */
function windowsSpelling(path: string): string {
  const p = path.replace(/^[\\/]{2}[?.][\\/](UNC[\\/])?/i, (_m, unc?: string) =>
    unc ? "\\\\" : "",
  );
  const head = /^(?:[a-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.exec(p)?.[0] ?? "";
  const rest = p
    .slice(head.length)
    .split(/[\\/]/)
    .map((seg) =>
      seg === "." || seg === ".." ? seg : seg.replace(/:.*$/, "").replace(/[. ]+$/, ""),
    )
    .join("\\");
  return `${head}${rest}`;
}

function isUnder(paths: typeof posix, dir: string, target: string): boolean {
  const rel = paths.relative(paths.resolve(dir), target);
  return rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
}

/** The path resolved against the call's cwd (else the root), in the file system's own spelling. */
function resolved(
  path: string,
  at: Placement,
  paths: typeof posix,
): { readonly abs?: string; readonly spelled: string } {
  const p0 = expandHome(path, at.home);
  const p = paths === win32 ? windowsSpelling(p0) : p0;
  const base = at.cwd ?? at.root;
  if (paths.isAbsolute(p)) return { abs: paths.resolve(p), spelled: p };
  if (base === undefined) return { spelled: p };
  const b = paths === win32 ? windowsSpelling(base) : base;
  return { abs: paths.resolve(paths.resolve(b), p), spelled: p };
}

/**
 * Is `path` inside the session's root? A relative path resolves against the call's cwd (where
 * the tool would find it), then is measured against the root, so a `cd` into `node_modules`
 * does not turn the project's own files into "outside". Undefined with neither cwd nor root.
 */
export function insideWorkspace(path: string, at: Placement): boolean | undefined {
  const root = at.root ?? at.cwd;
  if (root === undefined) return undefined;
  const paths = pathsFor(root, at.cwd);
  const p = expandHome(path, at.home);
  if (paths === posix && windowsVolume.test(p) && !p.startsWith("//")) return false;
  const { abs } = resolved(p, { ...at, root }, paths);
  return abs !== undefined && isUnder(paths, root, abs);
}

/**
 * Files and trees that configure an agent harness, wherever they are (the user's home, a
 * project, or a home that is also the session's root): Claude Code's `.claude/settings*.json`,
 * credentials, `CLAUDE.md`, and its `hooks/`, `agents/`, `commands/`, `skills/`, `plugins/` and
 * `output-styles/` (an agent can set its own permission mode, a skill or command its allowed
 * tools), `~/.claude.json`, a project's `.mcp.json`, managed settings; Codex's
 * `.codex/config.toml`, `auth.json`, `hooks.json`, `AGENTS.md`, `rules/`, `prompts/`, `agents/`
 * and `skills/`. The same set commands are matched against (`CONFIG_TOKEN`). Matched on the
 * resolved path, lower-cased, so `.\`, `x\..\`, doubled separators, trailing dots and stream
 * suffixes do not hide one.
 */
const HARNESS_CONFIG_SHAPES: readonly RegExp[] = [
  /(?:^|\/)\.claude\/(?:settings(?:\.local)?\.json|managed-settings\.json|\.credentials\.json|claude\.md)$/,
  /(?:^|\/)\.claude\/(?:hooks|agents|commands|skills|plugins|output-styles)(?:\/|$)/,
  /(?:^|\/)\.claude\.json$/,
  /(?:^|\/)\.mcp\.json$/,
  /(?:^|\/)claudecode\/managed-settings\.json$|^\/etc\/claude-code\//,
  /(?:^|\/)\.codex\/(?:config\.toml|auth\.json|hooks\.json|agents\.md)$/,
  /(?:^|\/)\.codex\/(?:rules|prompts|agents|skills)(?:\/|$)/,
];

/**
 * Credential files, wherever they are: SSH private keys, key and certificate stores, cloud,
 * registry and package-index credentials, the harnesses' own tokens. Commands are matched
 * against the same set (`CREDENTIAL_TOKEN`). A `.env` file counts only outside the workspace.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /(?:^|\/)\.ssh\/(?:id_[^/]*|identity)$(?<!\.pub)/,
  /[^/]\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/,
  /(?:^|\/)\.aws\/credentials$/,
  /(?:^|\/)[._]netrc$/,
  /(?:^|\/)\.(?:npmrc|pypirc|git-credentials)$/,
  /(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)\.kube\/config$/,
  /(?:^|\/)\.claude\/\.credentials\.json$/,
  /(?:^|\/)\.codex\/auth\.json$/,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/,
  /(?:^|\/)\.gnupg\//,
];
const ENV_FILE = /(?:^|\/)\.env(?:\.(?!(?:example|sample|template|dist)$)[\w-]+)?$/;

const flat = (p: string): string => p.replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();

/** A Windows path naming an alternate data stream (`notes.md:evil.ps1`, `x::$DATA`). */
function namesStream(path: string): boolean {
  const p = path.replace(/^[\\/]{2}[?.][\\/](?:UNC[\\/])?/i, "");
  const head = /^(?:[a-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.exec(p)?.[0] ?? "";
  return p.slice(head.length).includes(":");
}

/**
 * Where a path sits: inside the workspace, harness-owned (scratch space or notes), harness
 * configuration, a credential file. Configuration always wins: a configuration file is never
 * harness-owned, nor is anything that names an alternate data stream.
 */
export function placePath(
  path: string,
  at: Placement,
): {
  readonly insideWorkspace?: boolean;
  readonly harnessOwned: boolean;
  readonly harnessConfig: boolean;
  readonly credential: boolean;
} {
  const inside = insideWorkspace(path, at);
  const homes = at.harnessHomes ?? [];
  const scratch = at.harnessScratch ?? [];
  const style = pathsFor(path, at.cwd, at.root, ...homes, ...scratch);
  const { abs, spelled } = resolved(path, at, style);
  const shape = flat(abs ?? style.normalize(spelled));
  let config = HARNESS_CONFIG_SHAPES.some((re) => re.test(shape));
  const credential =
    CREDENTIAL_SHAPES.some((re) => re.test(shape)) || (inside !== true && ENV_FILE.test(shape));
  let owned = false;
  // A note's alternate data stream (`MEMORY.md:evil.ps1`) is not a note: never owned.
  const stream = style === win32 && namesStream(expandHome(path, at.home));
  if (abs !== undefined && path !== "") {
    for (const home of homes) {
      const paths = pathsFor(home);
      if (paths !== style || !isUnder(paths, home, abs)) continue;
      const rel = paths.relative(paths.resolve(home), abs).split(/[\\/]/);
      const note =
        rel.length >= 3 && /^projects$/i.test(rel[0] ?? "") && /^memory$/i.test(rel[2] ?? "");
      if (note) owned = true;
      else config = true;
    }
    for (const dir of scratch) {
      const paths = pathsFor(dir);
      if (paths === style && isUnder(paths, dir, abs)) owned = true;
    }
  }
  return {
    ...(inside === undefined ? {} : { insideWorkspace: inside }),
    harnessOwned: owned && !config && !stream,
    harnessConfig: config,
    credential,
  };
}

/** Under the harness's scratch space or its notes, and not configuration. */
export function harnessOwned(path: string, at: Placement): boolean {
  return placePath(path, at).harnessOwned;
}

/** Agent harness configuration, by its shape alone or, given its homes, by where it is. */
export function harnessConfig(path: string, at: Placement = {}): boolean {
  return placePath(path, at).harnessConfig;
}

/** Parse the headers of a Codex `apply_patch` body: which files, and how many lines each way. */
export function patchFacts(patch: string): {
  readonly paths: string[];
  readonly change: Extract<Change, { kind: "patch" }>;
} {
  const paths: string[] = [];
  let deletes = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      paths.push((header[2] as string).trim());
      if (header[1] === "Delete") deletes++;
      continue;
    }
    if (/^\*\*\* /.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return {
    paths,
    change: {
      kind: "patch",
      files: paths.length,
      addedLines: added,
      removedLines: removed,
      deletes,
    },
  };
}

/**
 * Describe one call the way the gate will see it. Unknown tools (MCP servers, anything new)
 * are reduced to the shape of their input: key names, value types and sizes, never values.
 * That is deliberately little to judge on; a per-tool subject is the way to give the gate more.
 *
 * `at` is either the call's cwd (the original signature) or a `Placement` that adds the
 * session's root and the harness's own directories.
 */
export function subjectOf(
  tool: string,
  input: Record<string, unknown>,
  at: string | undefined | Placement,
): Subject {
  const place: Placement = typeof at === "object" ? at : at === undefined ? {} : { cwd: at };
  if (COMMAND_TOOLS.has(tool)) {
    const { text: raw, shell } = commandOf(tool, input);
    const shown = scrubCapped(raw, COMMAND_MAX_CHARS);
    const read = viewsOf(raw.length > DIGEST_MAX_CHARS ? raw.slice(0, DIGEST_MAX_CHARS) : raw);
    return {
      kind: "command",
      command: shown.text,
      parts: countParts(raw),
      destructive: any(DESTRUCTIVE_COMMANDS, read, shell),
      opaque: any(OPAQUE_COMMANDS, read, shell),
      checkBypass: any(CHECK_BYPASS_COMMANDS, read, shell),
      uploads: any(UPLOAD_COMMANDS, read, shell),
      harnessConfig: any(HARNESS_CONFIG_COMMANDS, read, shell),
      credential: any(CREDENTIAL_COMMANDS, read, shell),
      truncated: shown.truncated,
      redacted: shown.redacted,
    };
  }
  if (PATH_TOOLS.has(tool)) return pathSubject(tool, input, place);
  if (tool === "WebFetch") {
    const shown = scrubCapped(str(input, "url") ?? "", URL_MAX_CHARS);
    return { kind: "url", url: shown.text, truncated: shown.truncated, redacted: shown.redacted };
  }
  if (tool === "WebSearch") {
    const shown = scrubCapped(str(input, "query") ?? "", QUERY_MAX_CHARS);
    return {
      kind: "query",
      query: shown.text,
      truncated: shown.truncated,
      redacted: shown.redacted,
    };
  }
  const capped = cap(shapeOf(input), SHAPE_MAX_CHARS);
  return { kind: "call", shape: capped.text, truncated: capped.truncated };
}

function pathSubject(tool: string, input: Record<string, unknown>, at: Placement): Subject {
  if (tool === "apply_patch") {
    const body = str(input, "input") ?? str(input, "patch") ?? "";
    const facts = patchFacts(body);
    // A file list longer than this is shown cut, which the floors review; placing every one of
    // 60,000 headers cost 2.5 s against the hook's 10 s timeout.
    const examined = facts.paths.slice(0, PATCH_MAX_PATHS);
    const placed = examined.map((p) => placePath(p, at));
    const shown = scrubCapped(examined.join(", "), PATH_MAX_CHARS);
    const config = placed.some((p) => p.harnessConfig);
    const truncated = shown.truncated || facts.paths.length > PATCH_MAX_PATHS;
    return {
      kind: "path",
      path: shown.text,
      ...(placed.length > 0 && placed.every((p) => p.insideWorkspace !== undefined)
        ? { insideWorkspace: placed.every((p) => p.insideWorkspace === true) }
        : {}),
      harnessOwned: !config && placed.length > 0 && placed.every((p) => p.harnessOwned),
      harnessConfig: config,
      credential: placed.some((p) => p.credential),
      readOnly: false,
      destructive: facts.change.deletes > 0,
      change: facts.change,
      ...(truncated ? { truncated: true as const } : {}),
      redacted: shown.redacted,
    };
  }
  const path =
    str(input, "file_path") ??
    str(input, "notebook_path") ??
    str(input, "path") ??
    str(input, "pattern") ??
    "";
  const placed = placePath(path, at);
  const shown = scrubCapped(path, PATH_MAX_CHARS);
  const base = {
    kind: "path" as const,
    path: shown.text,
    ...(placed.insideWorkspace === undefined ? {} : { insideWorkspace: placed.insideWorkspace }),
    harnessOwned: placed.harnessOwned,
    harnessConfig: placed.harnessConfig,
    credential: placed.credential,
    readOnly: READ_ONLY_TOOLS.has(tool),
    destructive: false,
    ...(shown.truncated ? { truncated: true as const } : {}),
    redacted: shown.redacted,
  };
  if (tool === "Write")
    return { ...base, change: { kind: "write", lines: lines(str(input, "content") ?? "") } };
  if (tool === "Edit") {
    return {
      ...base,
      change: {
        kind: "edit",
        removedLines: lines(str(input, "old_string") ?? ""),
        addedLines: lines(str(input, "new_string") ?? ""),
        replaceAll: input.replace_all === true,
      },
    };
  }
  if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let removed = 0;
    let added = 0;
    let replaceAll = false;
    for (const e of edits) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      removed += lines(str(o, "old_string") ?? "");
      added += lines(str(o, "new_string") ?? "");
      replaceAll ||= o.replace_all === true;
    }
    return {
      ...base,
      change: { kind: "edit", removedLines: removed, addedLines: added, replaceAll },
    };
  }
  if (tool === "NotebookEdit") {
    return { ...base, change: { kind: "write", lines: lines(str(input, "new_source") ?? "") } };
  }
  return base;
}

/** Keys, types and sizes; never values. */
export function shapeOf(input: Record<string, unknown>): string {
  const parts = Object.keys(input)
    .sort()
    .map((k) => {
      const v = input[k];
      if (typeof v === "string") return `${k}: string(${v.length})`;
      if (Array.isArray(v)) return `${k}: array(${v.length})`;
      if (v === null) return `${k}: null`;
      if (typeof v === "object") return `${k}: object(${Object.keys(v as object).length})`;
      return `${k}: ${typeof v}`;
    });
  return `{ ${parts.join(", ")} }`;
}
