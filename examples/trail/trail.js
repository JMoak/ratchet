/*
 * The decision trail viewer. Renders the Trail JSON the local server builds with the CLI's
 * own `buildTrail` (examples/trail/server.ts), so what the page shows is exactly what
 * `ratchet trail` prints. No framework, no build step; the page is one module and one
 * stylesheet, and every piece of data reaches the DOM through textContent.
 */

const $ = (id) => document.getElementById(id);
const ui = {
  source: $("source"),
  file: $("file"),
  theme: $("theme"),
  controls: $("controls"),
  gate: $("gate"),
  exceptions: $("exceptions"),
  follow: $("follow"),
  followWrap: $("follow-wrap"),
  find: $("find"),
  bars: $("bars"),
  list: $("list"),
  rows: $("rows"),
  none: $("none"),
  earlier: $("earlier"),
  earlierWrap: $("earlier-wrap"),
  empty: $("empty"),
  drop: $("drop"),
};

const PAGE = 300;
const POLL_MS = 4000;

const state = {
  trail: null,
  live: false,
  etag: null,
  pollTimer: 0,
  shown: PAGE,
  expanded: new Set(),
  filters: { gate: "", soft: "", label: "", exceptions: false, find: "" },
};

// ---------------------------------------------------------------------------------------
// Small DOM helpers. Attributes are set one by one; text is always textContent.
// ---------------------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(paths) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

/** One small glyph per strategy, drawn rather than iconed, so the shape says how it ran. */
const GLYPHS = {
  single: ["M8 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0"],
  ensemble: ["M3 8h0.01M8 8h0.01M13 8h0.01", "M3 5v6M8 5v6M13 5v6"],
  cascade: ["M2 13h4v-4h4v-4h4"],
  sequential: ["M2 8h9", "M8 5l3 3-3 3", "M13 5v6"],
  battery: ["M3 3h10v10H3z", "M3 8h10M8 3v10"],
  floored: ["M3 12h10", "M8 12V5", "M5 7l3-3 3 3"],
  bypass: ["M2 8h5", "M9 8h5", "M8 5v6"],
};
const glyphFor = (strategy) =>
  svg(GLYPHS[strategy] ?? ["M8 8m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0"]);

// ---------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dec = (x, d = 3) => (typeof x === "number" ? x.toFixed(d) : "–");
const usd = (x) => (x === 0 ? "$0" : x < 1 ? `$${x.toPrecision(3)}` : `$${x.toFixed(2)}`);
const short = (id) => (typeof id === "string" ? id.slice(0, 8) : "");
const baseName = (p) => p.split(/[\\/]/).pop() || p;

/** The strategy's own account, in the words `ratchet trail` uses. */
function describeDetail(e) {
  const d = e.detail;
  if (!d) return "";
  if (e.strategy === "cascade") {
    const tier = typeof d.tier === "number" ? d.tier + 1 : "?";
    const label = typeof d.tierLabel === "string" ? ` “${d.tierLabel}”` : "";
    const esc = typeof d.escalations === "number" ? d.escalations : 0;
    return `Settled at tier ${tier}${label} after ${esc} escalation${esc === 1 ? "" : "s"}; ${d.pooled ? "the tiers were pooled" : "the settling tier’s answer was kept"}.`;
  }
  if (e.strategy === "sequential") {
    const traj = Array.isArray(d.trajectory) ? d.trajectory.map((x) => dec(x, 2)).join(" → ") : "";
    return `${d.samples ?? "?"} samples, ${d.settled ? "settled" : "ran out of samples"}; pooled confidence ${traj}.`;
  }
  if (e.strategy === "ensemble") {
    return `${d.pooled ?? "?"} answers pooled, ${d.dropped ?? 0} dropped, at an assumed error correlation of ${dec(d.correlation ?? 0, 2)}.`;
  }
  if (e.strategy === "battery") {
    return `${d.members ?? e.members.length} members combined by ${d.combine ?? "?"}.`;
  }
  if (d.budgetExhausted) return `Budget exhausted (${d.budget}); no answer was bought.`;
  return Object.entries(d)
    .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

/**
 * Where a member sits on the evidence scale. The scale is the probability that acting is
 * right, which is what the bar reads; for a judge question that is p(yes) when yes means go
 * and 1 - p(yes) otherwise, and the ruling row says which by how its own go relates to its
 * p(yes). Pick and rate members sit at their confidence.
 */
function positionOf(e, m) {
  if (typeof m.pYes === "number" && typeof e.pYes === "number") {
    if (Math.abs(e.go - e.pYes) < 1e-9) return m.pYes;
    if (Math.abs(e.go - (1 - e.pYes)) < 1e-9) return 1 - m.pYes;
  }
  return m.confidence;
}

const isException = (e) =>
  e.failedOpen || e.fixed || e.floor !== undefined || e.audited || e.outcome?.correct === false;

// ---------------------------------------------------------------------------------------
// Rail: one horizontal scale from 0 to 1 that every row and every gate strip share.
// ---------------------------------------------------------------------------------------

function railBase(container) {
  container.append(el("span", { class: "rail-line" }));
  for (const x of [0, 0.5, 1]) {
    const t = el("span", { class: "rail-tick" });
    t.style.left = `${x * 100}%`;
    container.append(t);
  }
}

function railBand(container, bar) {
  if (!bar) return;
  const lo = typeof bar.above === "number" ? bar.above : 0;
  const hi = typeof bar.atOrBelow === "number" ? bar.atOrBelow : 1;
  if (bar.consistent && typeof bar.atOrBelow === "number") {
    const band = el("span", { class: "rail-band" });
    band.style.left = `${Math.min(lo, hi) * 100}%`;
    band.style.width = `${Math.max(0, hi - lo) * 100}%`;
    container.append(band);
    const line = el("span", { class: "rail-bar" });
    line.style.left = `${hi * 100}%`;
    container.append(line);
  } else if (!bar.consistent) {
    const band = el("span", { class: "rail-band" });
    band.style.left = `${Math.min(lo, hi) * 100}%`;
    band.style.width = `${Math.abs(hi - lo) * 100}%`;
    container.append(band);
  }
}

function rail(e, bar) {
  const r = el("span", { class: "rail", role: "img", "aria-label": railLabel(e) });
  railBase(r);
  railBand(r, bar);
  const xs = e.members.map((m) => (m.failedOpen ? null : positionOf(e, m)));
  const live = xs.filter((x) => x !== null);
  if (e.strategy === "cascade" && live.length > 1) {
    const path = el("span", { class: "rail-path" });
    const a = Math.min(...live);
    const b = Math.max(...live);
    path.style.left = `${a * 100}%`;
    path.style.width = `${(b - a) * 100}%`;
    r.append(path);
  }
  e.members.forEach((m, i) => {
    const t = el("span", {
      class: `rail-member${m.failedOpen ? " dropped" : ""}`,
      title: `${m.name}: ${m.failedOpen ? "failed open" : `${m.answer} ${dec(m.pYes ?? m.confidence, 2)}`}`,
    });
    t.style.left = `${(xs[i] ?? 0.5) * 100}%`;
    r.append(t);
  });
  if (!e.fixed) {
    const mark = el("span", {
      class: `rail-mark ${e.failedOpen ? "failed" : e.soft}`,
      title: `go ${dec(e.go)}`,
    });
    mark.style.left = `${e.go * 100}%`;
    r.append(mark);
  }
  return r;
}

function railLabel(e) {
  if (e.fixed) return "No answer bought.";
  if (e.failedOpen) return "Failed open; neutral evidence.";
  const members = e.members.length > 1 ? ` from ${e.members.length} answers` : "";
  return `Probability that acting is right ${dec(e.go)}${members}.`;
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

function whenCell(at) {
  const d = new Date(at);
  const ok = !Number.isNaN(d.getTime());
  return el("time", { class: "when", datetime: at, title: at }, [
    ok ? timeFmt.format(d) : at,
    ok ? el("small", { text: dateFmt.format(d) }) : null,
  ]);
}

function howCell(e) {
  const label =
    e.strategy === "single"
      ? e.oracle
      : e.strategy === "floored"
        ? "floor"
        : e.strategy === "bypass"
          ? "allowlist"
          : e.strategy;
  return el("span", { class: "how", title: e.oracle }, [
    glyphFor(e.strategy),
    label,
    e.members.length > 1 ? el("span", { class: "n", text: `×${e.members.length}` }) : null,
  ]);
}

function rulingCell(e) {
  const parts = [el("span", { class: `dot ${e.soft}` }), e.soft];
  if (e.action !== e.soft) {
    parts.push(el("span", { class: "arrow", text: "→" }));
    parts.push(el("span", { class: "applied", text: e.action }));
  }
  parts.push(el("span", { class: "mode", text: e.mode }));
  if (e.failedOpen) parts.push(el("span", { class: "flag", text: "failed open" }));
  else if (e.fixed) parts.push(el("span", { class: "flag soft", text: "fixed" }));
  else if (e.floor) parts.push(el("span", { class: "flag soft", text: `floor ${e.floor}` }));
  if (e.audited) parts.push(el("span", { class: "flag soft", text: "audit" }));
  return el("span", { class: "ruling" }, parts);
}

function labelCell(e) {
  if (!e.outcome) return el("span", { class: "label none", text: "–" });
  const o = e.outcome;
  return el("span", {
    class: `label ${o.correct ? "right" : "wrong"}`,
    text: o.correct ? "right" : "wrong",
    title: `${o.source ?? "label"} at ${o.at}${o.truth !== undefined ? `; truth ${o.truth}` : ""}`,
  });
}

function membersTable(e) {
  const judge = e.members.some((m) => typeof m.pYes === "number");
  const head = el("tr", {}, [
    el("th", { text: "#" }),
    el("th", { text: "Member" }),
    el("th", { text: "Answer" }),
    el("th", { class: judge ? "num nocase" : "num", text: judge ? "p(yes)" : "Confidence" }),
    el("th", { text: "Evidence" }),
    el("th", { class: "num", text: "Cost" }),
    el("th", { class: "num", text: "Latency" }),
    el("th", { text: "Note" }),
  ]);
  const body = e.members.map((m) => {
    const mini = el("span", { class: "rail mini" });
    railBase(mini);
    if (!m.failedOpen) {
      const mark = el("span", { class: "rail-mark hollow" });
      mark.style.left = `${positionOf(e, m) * 100}%`;
      mini.append(mark);
    }
    const notes = [
      m.role,
      m.correct === true ? "right" : m.correct === false ? "wrong" : null,
      m.error,
    ].filter(Boolean);
    return el("tr", {}, [
      el("td", { text: String(m.index) }),
      el("td", { text: m.model && m.model !== m.name ? `${m.name} (${m.model})` : m.name }),
      el("td", { text: m.failedOpen ? "failed open" : m.answer }),
      el("td", { class: "num", text: m.failedOpen ? "–" : dec(m.pYes ?? m.confidence, 2) }),
      el("td", {}, [mini]),
      el("td", { class: "num", text: usd(m.cost) }),
      el("td", { class: "num", text: `${Math.round(m.latencyMs)} ms` }),
      el("td", { class: m.correct === false ? "note-wrong" : "", text: notes.join(", ") || "–" }),
    ]);
  });
  return el("div", { class: "members" }, [
    el("h3", { text: `Answers bought (${e.members.length})` }),
    el("table", {}, [el("thead", {}, [head]), el("tbody", {}, body)]),
  ]);
}

function dl(pairs) {
  const node = el("dl");
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === "") continue;
    node.append(el("dt", { text: k }), el("dd", { class: "mono", text: String(v) }));
  }
  return node;
}

function detailPanel(e) {
  const o = e.outcome;
  const verdict = e.fixed
    ? `No answer was bought: ${e.strategy === "bypass" ? "an allowlist" : "a floor"} fixed the action at ${e.soft}.`
    : e.failedOpen
      ? `Failed open${e.error ? `: ${e.error}` : ""}. The verdict is the neutral placeholder and the policy's default applied.`
      : `${e.answer}${typeof e.pYes === "number" ? ` with p(yes) ${dec(e.pYes, 3)}` : ` at confidence ${dec(e.confidence, 3)}`}; probability that acting is right ${dec(e.go, 3)}${e.members.length > 1 ? `, agreement ${dec(e.agreement, 2)}` : ""}.`;
  const copy = el("button", {
    type: "button",
    text: "Copy request id",
    onclick: async (ev) => {
      try {
        await navigator.clipboard.writeText(e.requestId);
        ev.currentTarget.textContent = "Copied";
      } catch {
        ev.currentTarget.textContent = e.requestId;
      }
    },
  });
  return el("div", { class: "detail" }, [
    el("p", { class: "question", text: e.question }),
    el("p", { class: "summary", text: [verdict, describeDetail(e)].filter(Boolean).join(" ") }),
    e.members.length > 0 ? membersTable(e) : null,
    el("div", {}, [
      el("h3", { text: "Ruling" }),
      dl([
        ["engine said", e.soft],
        ["application did", e.action],
        ["mode", e.mode + (e.audited ? " (blind audit)" : "")],
        ["floor", e.floor],
        ["strategy", e.strategy === "single" ? "single" : `${e.strategy}: ${e.oracle}`],
        ["model", e.model],
        ["cost", usd(e.cost)],
        ["latency", `${Math.round(e.latencyMs)} ms`],
        ["tags", e.tags.length > 0 ? e.tags.join(", ") : undefined],
      ]),
    ]),
    el("div", {}, [
      el("h3", { text: "Provenance" }),
      dl([
        ["state", e.stateHash],
        ["trusted", e.trustedHash !== e.stateHash ? e.trustedHash : undefined],
        ["untrusted", e.untrusted.length > 0 ? e.untrusted.join(", ") : undefined],
        ["policy", e.policyHash],
        ["evidence", e.evidenceVersion],
        ["request", e.requestId],
        ["decision", e.id],
      ]),
    ]),
    el("div", {}, [
      el("h3", { text: "Label" }),
      o
        ? el("p", { class: o.correct ? "note-ok" : "note-wrong" }, [
            `${o.correct ? "Right" : "Wrong"}${o.truth !== undefined ? `, truth ${o.truth}` : ""}${o.source ? ` (${o.source})` : ""} at ${o.at}.`,
            o.note ? ` ${o.note}` : "",
          ])
        : el("p", { text: "Unlabelled." }),
    ]),
    el("div", { class: "actions" }, [copy]),
    el("details", {}, [
      el("summary", { text: "Raw entry" }),
      el("pre", { class: "mono", text: JSON.stringify(e, null, 2) }),
    ]),
  ]);
}

function rowFor(e, bar) {
  const open = state.expanded.has(e.id);
  const main = el(
    "button",
    {
      type: "button",
      class: "row-main",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": `d-${e.id}`,
      onclick: () => toggle(e.id),
    },
    [
      whenCell(e.at),
      el("span", { class: "gate", text: e.gate, title: e.gate }),
      howCell(e),
      rail(e, bar),
      rulingCell(e),
      labelCell(e),
    ],
  );
  const li = el("li", { class: "row", id: `r-${e.id}` }, [main]);
  if (open) {
    const d = detailPanel(e);
    d.id = `d-${e.id}`;
    li.append(d);
  }
  return li;
}

function toggle(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderRows();
  document.querySelector(`#r-${CSS.escape(id)} .row-main`)?.focus();
}

// ---------------------------------------------------------------------------------------
// Filtering and rendering
// ---------------------------------------------------------------------------------------

function filtered() {
  const f = state.filters;
  const needle = f.find.trim().toLowerCase();
  return state.trail.entries.filter((e) => {
    if (f.gate && e.gate !== f.gate) return false;
    if (f.soft && e.soft !== f.soft) return false;
    if (f.label === "labelled" && !e.outcome) return false;
    if (f.label === "unlabelled" && e.outcome) return false;
    if (f.label === "wrong" && e.outcome?.correct !== false) return false;
    if (f.exceptions && !isException(e)) return false;
    if (needle) {
      const hay = [e.question, e.requestId, e.id, e.stateHash, e.gate, e.oracle, e.model, ...e.tags]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function barFor(e) {
  return state.trail.bars.find(
    (b) => b.gate === e.gate && (b.policyHash ?? "") === (e.policyHash ?? ""),
  );
}

/** Filters live in the URL too, so a view, or one open decision, can be handed to someone. */
function syncUrl() {
  const f = state.filters;
  const q = new URLSearchParams();
  if (f.gate) q.set("gate", f.gate);
  if (f.soft) q.set("soft", f.soft);
  if (f.label) q.set("label", f.label);
  if (f.exceptions) q.set("exceptions", "1");
  if (f.find.trim()) q.set("q", f.find.trim());
  const open = [...state.expanded];
  if (open.length === 1) q.set("open", short(open[0]));
  const s = q.toString();
  history.replaceState(null, "", s ? `?${s}` : location.pathname);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  const f = state.filters;
  f.gate = q.get("gate") ?? "";
  f.soft = ["act", "review", "refuse"].includes(q.get("soft")) ? q.get("soft") : "";
  f.label = ["labelled", "wrong", "unlabelled"].includes(q.get("label")) ? q.get("label") : "";
  f.exceptions = q.get("exceptions") === "1";
  f.find = q.get("q") ?? "";
  ui.exceptions.checked = f.exceptions;
  ui.find.value = f.find;
  for (const name of ["soft", "label"]) {
    const input = document.querySelector(`input[name="${name}"][value="${f[name]}"]`);
    if (input) input.checked = true;
  }
  return { open: q.get("open"), theme: q.get("theme") };
}

function renderRows() {
  syncUrl();
  const all = filtered();
  const from = Math.max(0, all.length - state.shown);
  const slice = all.slice(from);
  ui.rows.replaceChildren(...slice.map((e) => rowFor(e, barFor(e))));
  ui.none.hidden = all.length > 0;
  ui.earlierWrap.hidden = from === 0;
  if (from > 0) ui.earlier.textContent = `Show earlier decisions (${from} more)`;
}

function renderBars() {
  const bars = state.trail.bars.filter((b) => !state.filters.gate || b.gate === state.filters.gate);
  ui.bars.hidden = bars.length === 0;
  ui.bars.replaceChildren(
    ...bars.map((b) => {
      const strip = el("span", { class: `rail bar-strip${b.consistent ? "" : " inconsistent"}` });
      railBase(strip);
      railBand(strip, b);
      const where =
        typeof b.above === "number" && typeof b.atOrBelow === "number"
          ? `act bar in (${dec(b.above)}, ${dec(b.atOrBelow)}]`
          : typeof b.atOrBelow === "number"
            ? `act bar ≤ ${dec(b.atOrBelow)}; nothing held`
            : typeof b.above === "number"
              ? `act bar > ${dec(b.above)}; nothing acted on`
              : "no answered rows";
      return el("div", { class: "bar-row" }, [
        el("span", { class: "bar-gate", title: b.gate }, [
          b.gate,
          b.policyHash ? el("small", { text: `policy ${short(b.policyHash)}` }) : null,
        ]),
        strip,
        el("span", {
          class: "bar-text",
          text: `${where}${b.consistent ? "" : " · rulings do not fit one bar"} · ${b.rows} rows`,
        }),
      ]);
    }),
  );
}

function renderSource() {
  const t = state.trail;
  const gates = new Set(t.entries.map((e) => e.gate)).size;
  const labelled = t.entries.filter((e) => e.outcome).length;
  ui.source.replaceChildren(
    el("span", { class: "mono", text: baseName(t.ledger) }),
    ` · ${t.total} decision${t.total === 1 ? "" : "s"} · ${gates} gate${gates === 1 ? "" : "s"} · ${labelled} labelled`,
    state.live ? el("span", { class: "live", text: " live" }) : "",
  );
  document.title = `${baseName(t.ledger)} · Ratchet trail`;
}

function renderGates() {
  const current = state.filters.gate;
  const gates = [...new Set(state.trail.entries.map((e) => e.gate))].sort();
  ui.gate.replaceChildren(
    el("option", { value: "", text: "All gates" }),
    ...gates.map((g) => el("option", { value: g, text: g })),
  );
  ui.gate.value = gates.includes(current) ? current : "";
  state.filters.gate = ui.gate.value;
}

function render({ scroll = false } = {}) {
  const had = ui.rows.childElementCount;
  if (fromUrl.open && state.trail) {
    const hit = state.trail.entries.find((e) => e.id.startsWith(fromUrl.open));
    if (hit) state.expanded.add(hit.id);
    fromUrl.open = null;
  }
  ui.empty.hidden = true;
  ui.controls.hidden = false;
  ui.list.hidden = false;
  ui.followWrap.hidden = !state.live;
  renderSource();
  renderGates();
  renderBars();
  renderRows();
  if (scroll && state.live && ui.follow.checked && ui.rows.childElementCount !== had) {
    ui.rows.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }
}

function setTrail(trail, { live }) {
  state.trail = trail;
  state.live = live;
  render({ scroll: true });
}

// ---------------------------------------------------------------------------------------
// Loading: the server's ledger (polled by ETag) or a dropped file (posted once).
// ---------------------------------------------------------------------------------------

async function pollServer() {
  try {
    const res = await fetch("/api/trail", {
      headers: state.etag ? { "If-None-Match": state.etag } : {},
      cache: "no-store",
    });
    if (res.status === 304) return true;
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`${res.status}`);
    state.etag = res.headers.get("ETag");
    setTrail(await res.json(), { live: true });
    return true;
  } catch (e) {
    ui.source.textContent = `Could not read the ledger (${e instanceof Error ? e.message : e}).`;
    return true;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (!document.hidden) pollServer();
  }, POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

async function openFile(file) {
  if (!file) return;
  ui.source.textContent = `Reading ${file.name}…`;
  stopPolling();
  try {
    const res = await fetch(`/api/trail?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `${res.status}`);
    state.expanded.clear();
    state.shown = PAGE;
    setTrail(data, { live: false });
  } catch (e) {
    ui.source.textContent = `${file.name}: ${e instanceof Error ? e.message : e}`;
  }
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

ui.file.addEventListener("change", () => openFile(ui.file.files?.[0]));
$("choose").addEventListener("click", () => ui.file.click());
for (const type of ["dragenter", "dragover"]) {
  document.addEventListener(type, (ev) => {
    ev.preventDefault();
    ui.drop.classList.add("over");
  });
}
document.addEventListener("dragleave", (ev) => {
  if (ev.relatedTarget === null) ui.drop.classList.remove("over");
});
document.addEventListener("drop", (ev) => {
  ev.preventDefault();
  ui.drop.classList.remove("over");
  openFile(ev.dataTransfer?.files?.[0]);
});

ui.gate.addEventListener("change", () => {
  state.filters.gate = ui.gate.value;
  state.shown = PAGE;
  renderBars();
  renderRows();
});
for (const name of ["soft", "label"]) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.addEventListener("change", () => {
      state.filters[name] = input.value;
      state.shown = PAGE;
      renderRows();
    });
  }
}
ui.exceptions.addEventListener("change", () => {
  state.filters.exceptions = ui.exceptions.checked;
  state.shown = PAGE;
  renderRows();
});
let findTimer = 0;
ui.find.addEventListener("input", () => {
  window.clearTimeout(findTimer);
  findTimer = window.setTimeout(() => {
    state.filters.find = ui.find.value;
    state.shown = PAGE;
    renderRows();
  }, 120);
});
ui.earlier.addEventListener("click", () => {
  state.shown += PAGE;
  renderRows();
});

document.addEventListener("keydown", (ev) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "");
  if (ev.key === "/" && !typing) {
    ev.preventDefault();
    ui.find.focus();
    return;
  }
  if (typing || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  if (ev.key === "j" || ev.key === "k") {
    const mains = [...ui.rows.querySelectorAll(".row-main")];
    if (mains.length === 0) return;
    const i = mains.indexOf(document.activeElement);
    const next = ev.key === "j" ? Math.min(mains.length - 1, i + 1) : Math.max(0, i - 1);
    mains[next]?.focus();
    mains[next]?.scrollIntoView({ block: "nearest" });
    ev.preventDefault();
  }
});

// Theme: follow the system until the person chooses; remember the choice if storage allows.
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "dark" || choice === "light") root.dataset.theme = choice;
  else delete root.dataset.theme;
  const dark =
    choice === "dark" ||
    (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  ui.theme.textContent = dark ? "Light" : "Dark";
  ui.theme.setAttribute("aria-pressed", dark ? "true" : "false");
}
let themeChoice = null;
try {
  themeChoice = localStorage.getItem("ratchet-trail-theme");
} catch {
  themeChoice = null;
}
applyTheme(themeChoice);
ui.theme.addEventListener("click", () => {
  const dark = ui.theme.getAttribute("aria-pressed") === "true";
  themeChoice = dark ? "light" : "dark";
  try {
    localStorage.setItem("ratchet-trail-theme", themeChoice);
  } catch {
    // Storage may be blocked; the choice still applies to this page.
  }
  applyTheme(themeChoice);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!themeChoice) applyTheme(null);
});

// Go.
const fromUrl = readUrl();
if (fromUrl.theme === "light" || fromUrl.theme === "dark") applyTheme(fromUrl.theme);
pollServer().then((served) => {
  if (served) startPolling();
});
