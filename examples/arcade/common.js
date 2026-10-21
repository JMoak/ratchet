export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });

let model = "offline";
let modelControl;
let modelStatus;
let modelControlLocked = false;
let pendingRequests = 0;

/** New worlds vary; replay keeps the existing seed and therefore the same physical world. */
export function newWorldSeed(previous) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_001;
  return seed === previous ? (seed + 1) % 1_000_001 : seed;
}

/** Lock the brain for the entire run, including the short gaps between turns. */
export function setModelControlLocked(locked) {
  modelControlLocked = locked;
  if (modelControl) modelControl.disabled = locked || pendingRequests > 0;
}

/** Interruption only stops play; visibility and keyboard events never start it. */
export function installPauseGuards(documentTarget, windowTarget, isRunning, interrupt) {
  documentTarget.addEventListener("visibilitychange", () => {
    if (documentTarget.hidden && isRunning())
      interrupt(
        "Paused while you were away. A turn already requested may finish. Press Play to continue.",
      );
  });
  documentTarget.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && isRunning()) {
      event.preventDefault();
      interrupt("Paused. Take a moment, make a move yourself, or press Play to continue.");
    }
  });
  windowTarget.addEventListener("pagehide", () => {
    if (isRunning()) interrupt("Paused when you left the game. Press Play to continue.");
  });
}

/** Presentation controls never change a seed, policy, command, or model request. */
export function setupPlayback({ board, controls, pause, isRunning }) {
  const bar = document.createElement("div");
  bar.className = "playback-bar";
  board.before(bar);
  bar.append(controls);
  controls.classList.add("playback-actions");
  const options = document.createElement("div");
  options.className = "playback-options";
  options.innerHTML =
    '<label>Turn pace <select aria-label="Turn pace"><option value="1800">Watch · 1.8s</option><option value="3200">Consider · 3.2s</option><option value="650">Quick · 0.65s</option></select></label><button type="button" class="secondary" aria-pressed="false">Focus game</button>';
  bar.append(options);
  const pace = options.querySelector("select");
  const focus = options.querySelector("button");
  const note = document.createElement("p");
  note.className = "playback-note";
  note.setAttribute("role", "status");
  note.textContent = "Escape pauses. Leaving this tab pauses; returning never starts a turn.";
  bar.append(note);
  let interruption = "";
  focus.addEventListener("click", () => {
    const focused = document.body.classList.toggle("focus-play");
    focus.setAttribute("aria-pressed", String(focused));
    focus.textContent = focused ? "Full page" : "Focus game";
    board.style.scrollMarginTop = `${bar.offsetHeight + 16}px`;
    board.scrollIntoView({ block: "start", behavior: "instant" });
  });
  const interrupt = (message) => {
    if (!isRunning()) return;
    interruption = message;
    pause();
  };
  installPauseGuards(document, window, isRunning, interrupt);
  return {
    delay: () => Number(pace.value),
    started: () => {
      interruption = "";
      note.textContent = "Watching the agent. Escape pauses; a turn already requested may finish.";
    },
    sync: ({ running, busy, done }) => {
      note.textContent = done
        ? "Run complete. Replay this world or start a new one from Full page."
        : running
          ? busy
            ? "The agent is considering its next move. Escape pauses after this request."
            : "Watching the agent. Escape pauses; leaving this tab pauses too."
          : busy
            ? "Finishing the requested update. No further turn starts automatically."
            : interruption ||
              "Take your time. Play, step once, or make a move yourself. Escape pauses.";
    },
  };
}

/** Backend selection is explicit, and changing it starts a new game. */
export async function setupModelControl(onChange) {
  const panel = document.createElement("section");
  panel.className = "model-control";
  panel.setAttribute("aria-label", "Decision model");
  panel.innerHTML =
    '<label>Agent brain <select aria-label="Agent brain"><option value="offline">Offline demo</option></select></label><span class="muted" role="status">Checking live model availability…</span>';
  document.querySelector(".topbar")?.after(panel);
  modelControl = panel.querySelector("select");
  modelStatus = panel.querySelector("[role=status]");
  setModelControlLocked(modelControlLocked);
  try {
    const response = await fetch("/api/capabilities");
    if (!response.ok) throw new Error("Capabilities unavailable.");
    const capabilities = await response.json();
    if (capabilities.liveAvailable) {
      const option = document.createElement("option");
      option.value = "live";
      option.textContent = `Live ${capabilities.oracle}`;
      modelControl.append(option);
      modelStatus.textContent =
        "Offline is free. Live sends game observations to the configured paid model.";
    } else {
      modelStatus.textContent =
        "Seeded demo agent. For live AI: restart with ARCADE_LIVE=1 and a server API key.";
    }
  } catch {
    modelStatus.textContent = "Offline demo available; live connection could not be checked.";
  }
  modelControl.addEventListener("change", () => {
    model = modelControl.value;
    modelStatus.textContent =
      model === "live"
        ? "Live model selected. Choices use the model; code controls the game."
        : "Offline demo selected. Choices use seeded toy judges.";
    onChange?.();
  });
}

export async function request(game, input) {
  pendingRequests++;
  setModelControlLocked(modelControlLocked);
  try {
    const response = await fetch(`/api/${encodeURIComponent(game)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, model }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The round could not run. Try again.");
    if (modelStatus && result.backend?.kind === "live") {
      const backend = result.backend;
      modelStatus.textContent =
        `Live ${backend.oracle} · ${backend.calls}/${backend.limits.maxCalls} requests · ` +
        `$${backend.reportedCost.toFixed(6)} reported` +
        (backend.blockedReason ? ` · ${backend.blockedReason}` : " · replays cached");
    }
    return result;
  } finally {
    pendingRequests--;
    setModelControlLocked(modelControlLocked);
  }
}

export function showLedger(element, ledger) {
  const rows = ledger?.decisions ?? [];
  element.innerHTML = rows.length
    ? `<div class="table-scroll"><table><caption>Decision trail · ${rows.length} decisions</caption>
      <thead><tr><th>Gate</th><th>P(go)</th><th>Suggested</th><th>Applied</th><th>Mode</th><th>World truth</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td>${escapeHtml(r.gate)}</td>
          <td>${r.failedOpen ? "Judge unavailable" : !r.answered ? "Code rule" : `${(r.probability * 100).toFixed(1)}%`}</td>
          <td><span class="badge">${escapeHtml(r.suggested)}</span></td>
          <td>${escapeHtml(r.actual)}</td><td>${escapeHtml(r.mode)}</td>
          <td>${r.truth === null ? "Unlabelled" : escapeHtml(r.truth)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="muted">Your decisions will appear here after you play.</p>';
}

export function downloadLedger(rows) {
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
