/**
 * The shared page driver. Every game is a duel: the server runs one seeded world two ways, then
 * 500 worlds two ways, and this module draws both and re-asks whenever a lever moves. Watching is
 * a replay of a result that is already on the page; it makes no request.
 */
export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });

const $ = (id) => document.getElementById(id);
/** A rate as a percentage: whole numbers in the middle, a decimal near either end. */
const pct = (x, fine = false) => {
  const v = 100 * x;
  const whole = Math.abs(v - Math.round(v)) < 0.05;
  return `${v.toFixed(fine ? 2 : !whole && (v < 10 || v > 90) ? 1 : 0)}%`;
};
const num = (x, fine = false) =>
  fine ? x.toFixed(2) : Number.isInteger(x) || Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1);
const show = (x, unit, fine = false) => (unit === "pct" ? pct(x, fine) : num(x, fine));

/** A seed that differs from the last one, so New world always changes the world. */
export function newWorldSeed(previous) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_001;
  return seed === previous ? (seed + 1) % 1_000_001 : seed;
}

/** Form controls as the settings object the server validates: numbers, booleans and strings. */
export function readLevers(form) {
  const settings = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") settings[el.name] = el.checked;
    else if (el.type === "range" || el.type === "number" || el.dataset.type === "number")
      settings[el.name] = Number(el.value);
    else settings[el.name] = el.value;
  }
  return settings;
}

/** Each `<output data-for="name">` shows its lever's value, as a percentage when asked. */
function syncOutputs(form) {
  for (const out of form.querySelectorAll("output[data-for]")) {
    const el = form.elements[out.dataset.for];
    if (!el) continue;
    const value = Number(el.value);
    out.textContent = out.dataset.format === "pct" ? `${Math.round(value * 100)}%` : el.value;
  }
}

function renderArms(el, arms) {
  const longest = Math.max(...arms.map((a) => a.cells.length));
  el.innerHTML = arms
    .map(
      (arm) => `<div class="arm" data-arm="${escapeHtml(arm.id)}">
        <div class="arm-head"><strong>${escapeHtml(arm.label)}</strong>
          <span class="verdict ${escapeHtml(arm.verdict)}">${escapeHtml(arm.summary)}</span></div>
        <div class="strip${longest > 40 ? " dense" : ""}">${arm.cells
          .map(
            (cell, i) =>
              `<span class="cell ${escapeHtml(cell.kind)}" data-i="${i}" title="${escapeHtml(cell.note)}">${escapeHtml(cell.text ?? "")}</span>`,
          )
          .join("")}</div></div>`,
    )
    .join("");
}

function renderBatch(el, batch) {
  el.innerHTML = `<div class="table-scroll"><table class="batch">
    <thead><tr><th></th><th>${escapeHtml(batch.labels?.[0] ?? "Without")}</th><th>${escapeHtml(batch.labels?.[1] ?? "With the engine")}</th></tr></thead>
    <tbody>${batch.rows
      .map((row) => {
        const won =
          row.better === "none" || row.baseline === row.engine
            ? ""
            : (row.better === "high") === row.engine > row.baseline
              ? " won"
              : " lost";
        const bar = (x, side) =>
          row.unit === "pct"
            ? `<span class="bar ${side}" style="width:${Math.max(0, Math.min(1, x)) * 100}%"></span>`
            : "";
        return `<tr><th scope="row">${escapeHtml(row.label)}</th>
          <td><span class="figure">${show(row.baseline, row.unit)}</span>${bar(row.baseline, "base")}</td>
          <td class="${won}"><span class="figure">${show(row.engine, row.unit)}</span>${bar(row.engine, "eng")}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
}

function renderTarget(target) {
  $("target-text").textContent = target.text;
  $("checks").innerHTML = target.checks
    .map((c) => {
      // A miss that rounds to its goal is shown finer, so "30% needs at least 30%" never appears.
      const fine = !c.met && show(c.value, c.unit) === show(c.goal, c.unit);
      const needs = c.sense === "min" ? "needs at least" : "needs at most";
      return `<li class="${c.met ? "met" : "missed"}"><span>${c.met ? "✓" : "✗"} ${escapeHtml(c.label)}</span>
        <span><strong>${show(c.value, c.unit, fine)}</strong> <small>${needs} ${show(c.goal, c.unit)}</small></span></li>`;
    })
    .join("");
  const status = $("target-status");
  const missing = target.checks.filter((c) => !c.met).length;
  status.className = target.met ? "target-status met" : "target-status";
  status.textContent = target.met
    ? "Target met. Try a harder world, or meet it with fewer resources."
    : `${missing} of ${target.checks.length} still to meet. Move a lever; the figures update at once.`;
}

/** A small line chart of rates against one lever, with the current setting marked. */
function renderSweep(el, sweep) {
  const [w, h, left, bottom, top] = [640, 240, 44, 34, 12];
  const xs = sweep.values;
  const x = (i) => left + (i / (xs.length - 1)) * (w - left - 12);
  const y = (v) => top + (1 - v) * (h - top - bottom);
  const colors = ["#246c52", "#b95e36", "#b08a2e", "#366d91"];
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line x1="${left}" x2="${w - 12}" y1="${y(v)}" y2="${y(v)}" stroke="#e1e6df"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`,
    )
    .join("");
  const ticks = xs
    .map((v, i) => `<text x="${x(i)}" y="${h - 12}" text-anchor="middle">${v}</text>`)
    .join("");
  const nearest = xs.reduce(
    (best, v, i) => (Math.abs(v - sweep.current) < Math.abs(xs[best] - sweep.current) ? i : best),
    0,
  );
  const lines = sweep.series
    .map((s, k) => {
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
      const dots = s.values
        .map(
          (v, i) =>
            `<circle cx="${x(i)}" cy="${y(v)}" r="${i === nearest ? 5 : 2.5}" fill="${colors[k]}"/>`,
        )
        .join("");
      return `<path d="${d.join(" ")}" fill="none" stroke="${colors[k]}" stroke-width="2.5"/>${dots}`;
    })
    .join("");
  const legend = sweep.series
    .map((s, k) => `<span><i style="background:${colors[k]}"></i>${escapeHtml(s.label)}</span>`)
    .join("");
  el.innerHTML = `<div class="chart-legend">${legend}<span class="muted">larger dots mark your setting</span></div>
    <svg class="sweep" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(sweep.lever)} swept across its range">
      ${grid}<line x1="${x(nearest)}" x2="${x(nearest)}" y1="${top}" y2="${h - bottom}" stroke="#c9d2cc" stroke-dasharray="4 4"/>
      ${lines}${ticks}</svg><p class="muted">${escapeHtml(sweep.lever)}, with every other lever as you set it.</p>`;
}

function renderLedger(el, ledger) {
  const rows = ledger?.decisions ?? [];
  el.innerHTML = rows.length
    ? `<div class="table-scroll"><table><caption>${rows.length} decisions in this world</caption>
      <thead><tr><th>Gate</th><th>P(go)</th><th>Ruled</th><th>Applied</th><th>Mode</th><th>World truth</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td>${escapeHtml(r.gate)}</td>
          <td>${r.failedOpen ? "Judge unavailable" : !r.answered ? "Code rule" : `${(r.probability * 100).toFixed(1)}%`}</td>
          <td><span class="badge">${escapeHtml(r.suggested)}</span></td>
          <td>${escapeHtml(r.actual)}</td><td>${escapeHtml(r.mode)}</td>
          <td>${r.truth === null ? "Unlabelled" : escapeHtml(r.truth)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="muted">No decision went through a gate in this world.</p>';
}

function downloadLedger(rows) {
  const blob = new Blob([`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`], {
    type: "application/x-ndjson",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ratchet-game-ledger.jsonl";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The backend choice: offline by default, live only when the server offers it and you pick it. */
async function setupModel(onChange) {
  const select = $("model");
  const status = $("model-status");
  try {
    const response = await fetch("/api/capabilities");
    const capabilities = response.ok ? await response.json() : {};
    if (capabilities.liveAvailable && select.dataset.live !== "off") {
      const option = document.createElement("option");
      option.value = "live";
      option.textContent = `Live ${capabilities.oracle}, this world only`;
      select.append(option);
      status.textContent =
        "Live judges this one world and costs money; the 500 worlds stay seeded.";
    } else {
      status.textContent = "Seeded toy judges. No key, no network, nothing billed.";
    }
  } catch {
    status.textContent = "Seeded toy judges.";
  }
  select.addEventListener("change", onChange);
  return () => select.value;
}

/**
 * Drive one game page. `game` is the API route; `after` may draw anything game-specific from the
 * full response. The page supplies the form of levers and the legend.
 */
export async function mount({ game, after }) {
  const form = $("levers");
  const params = new URLSearchParams(location.search);
  let seed = Number(params.get("seed") ?? form.dataset.seed ?? 1);
  if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000) seed = 1;
  let generation = 0;
  let result = null;
  let timer = null;
  let playing = null;
  const model = await setupModel(() => run());

  const stopWatching = () => {
    if (playing !== null) clearInterval(playing);
    playing = null;
    for (const cell of document.querySelectorAll(".cell.hidden")) cell.classList.remove("hidden");
    $("watch").textContent = "Watch it happen";
  };

  async function run({ sweep = false } = {}) {
    const mine = ++generation;
    stopWatching();
    document.body.classList.add("busy");
    $("error").textContent = "";
    try {
      const response = await fetch(`/api/${encodeURIComponent(game)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...readLevers(form), seed, sweep, model: model() }),
      });
      const data = await response.json();
      if (mine !== generation) return;
      if (!response.ok) throw new Error(data.error || "The world could not be run.");
      result = data;
      $("world-note").textContent = `World ${data.seed}. ${data.world.note}`;
      renderArms($("arms"), data.world.arms);
      $("caption").textContent = "Point at a square to read what happened there.";
      $("headline").textContent = data.batch.headline;
      $("batch-title").textContent = `The same duel in ${data.batch.worlds} worlds`;
      renderBatch($("batch"), data.batch);
      renderTarget(data.target);
      if (data.sweep) renderSweep($("sweep-chart"), data.sweep);
      else if (!sweep) $("sweep-chart").innerHTML = "";
      renderLedger($("ledger"), data.ledger);
      $("source").textContent =
        data.judgeSource === "live"
          ? "This world's engine arm was judged by the live model. The 500 worlds are seeded."
          : "Every judge here is a seeded simulation with a known error rate.";
      after?.(data);
    } catch (error) {
      if (mine === generation) $("error").textContent = error.message;
    } finally {
      if (mine === generation) document.body.classList.remove("busy");
    }
  }

  form.addEventListener("input", () => {
    syncOutputs(form);
    clearTimeout(timer);
    timer = setTimeout(() => run(), 140);
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  $("new").addEventListener("click", () => {
    seed = newWorldSeed(seed);
    history.replaceState(null, "", `?seed=${seed}`);
    run();
  });
  $("sweep").addEventListener("click", () => run({ sweep: true }));
  $("download").addEventListener("click", () => {
    if (result?.ledger?.rows) downloadLedger(result.ledger.rows);
  });
  $("arms").addEventListener("pointerover", (event) => {
    const cell = event.target.closest(".cell");
    if (cell && playing === null) $("caption").textContent = cell.title;
  });
  // Watching reveals the squares already on the page, one index at a time in every arm.
  $("watch").addEventListener("click", () => {
    if (playing !== null) return stopWatching();
    if (!result) return;
    const arms = [...document.querySelectorAll(".arm")];
    const length = Math.max(...arms.map((arm) => arm.querySelectorAll(".cell").length));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || length === 0) return;
    for (const cell of document.querySelectorAll(".cell")) cell.classList.add("hidden");
    $("watch").textContent = "Skip to the end";
    let i = 0;
    const step = () => {
      const notes = [];
      for (const arm of arms) {
        const cell = arm.querySelector(`.cell[data-i="${i}"]`);
        if (!cell) continue;
        cell.classList.remove("hidden");
        notes.push(`${arm.querySelector("strong").textContent}: ${cell.title}`);
      }
      $("caption").textContent = notes.join("  ·  ");
      if (++i >= length) stopWatching();
    };
    step();
    playing = setInterval(step, Math.max(25, Math.min(700, 6000 / length)));
  });

  syncOutputs(form);
  await run();
  return { run, result: () => result };
}
