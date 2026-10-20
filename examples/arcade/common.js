export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });

export async function request(game, input) {
  const response = await fetch(`/api/${encodeURIComponent(game)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The round could not run. Try again.");
  return result;
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
