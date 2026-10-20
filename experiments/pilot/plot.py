"""Render a saved pilot run without rerunning a model or executing fixture actions.

Usage: python experiments/pilot/plot.py RUN_DIR [OUTPUT_DIR]
Requires matplotlib. JSON inputs and generated local chart files form the report bundle.
"""

from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path
from urllib.parse import quote, urlsplit

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter


NAVY = "#172B4D"
TEAL = "#16857D"
BLUE = "#486FB1"
ROSE = "#BD5068"
MUTED = "#627187"
GRID = "#DFE5EC"
REVIEW = "#D5DEE8"
PAPER = "#FFFFFF"
TASK_NAMES = {"tool-gate": "Tool gate", "output-verifier": "Output verifier"}
TASK_COLORS = {"tool-gate": TEAL, "output-verifier": BLUE}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def escape(value) -> str:
    return html.escape(str(value), quote=True)


def local_link(path: Path, output: Path) -> str:
    return escape(quote(Path(os.path.relpath(path, output)).as_posix(), safe="/."))


def groups(results: dict, task: str | None = None, split: str | None = None) -> int:
    return len(
        {
            row["group"]
            for row in results["cases"]
            if (task is None or row["task"] == task)
            and (split is None or row["split"] == split)
        }
    )


def configure_style() -> None:
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "text.color": NAVY,
            "axes.labelcolor": NAVY,
            "axes.edgecolor": GRID,
            "axes.titleweight": "bold",
            "axes.titlesize": 12,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "xtick.major.size": 0,
            "ytick.major.size": 0,
            "axes.labelpad": 12,
            "figure.facecolor": PAPER,
            "axes.facecolor": PAPER,
            "savefig.facecolor": PAPER,
            "svg.hashsalt": "ratchet-pilot-v1",
        }
    )


def heading(fig, kicker: str, title: str, subtitle: str) -> None:
    fig.text(0.06, 0.955, kicker.upper(), fontsize=9, weight="bold", color=TEAL)
    fig.text(0.06, 0.895, title, fontsize=21, weight="bold")
    fig.text(0.06, 0.85, subtitle, fontsize=10.5, color=MUTED)


def save(fig, output: Path, stem: str) -> None:
    for suffix in ("png", "svg"):
        fig.savefig(
            output / f"{stem}.{suffix}",
            dpi=180,
            metadata={"Creator": "ratchet pilot"} if suffix == "svg" else None,
        )
    plt.close(fig)


def backend_label(results: dict) -> str:
    return "LIVE MODEL CALLS" if results["backend"] == "live" else "SIMULATED ORACLE"


def candidate_fingerprint(candidate: dict) -> str:
    if "policyHash" in candidate:
        return f"Policy fingerprint <code>{escape(candidate['policyHash'])}</code>"
    value = candidate.get("rubricThresholdHash", candidate.get("hash", "not recorded"))
    return f"Rubric/threshold fingerprint <code>{escape(value)}</code>"


def plot_actions(results: dict, output: Path) -> None:
    rows = [
        (task, split, task[split])
        for task in results["byTask"]
        for split in ("validation", "challenge")
    ]
    n = sum(summary["n"] for _, _, summary in rows)
    related_groups = sum(
        groups(results, task["task"], split) for task, split, _ in rows
    )
    acts = sum(summary["suggestedActs"] for _, _, summary in rows)
    wrong = sum(summary["wrongSuggestedActs"] for _, _, summary in rows)
    actual = sum(summary["actualActs"] for _, _, summary in rows)
    fig = plt.figure(figsize=(12.5, 7.1))
    heading(
        fig,
        f"{backend_label(results)} / AUTHORED FIXTURES",
        "What the frozen policies would suggest",
        f"{n} held-out fixtures in {related_groups} related groups"
        "  |  validation and challenge are reported separately",
    )
    ax = fig.add_axes((0.26, 0.235, 0.68, 0.46))
    colors = (TEAL, ROSE, REVIEW, NAVY)
    for index, (task, split, summary) in enumerate(rows):
        values = (
            summary["suggestedActs"] - summary["wrongSuggestedActs"],
            summary["wrongSuggestedActs"],
            summary["suggestedReviews"],
            summary["suggestedRefusals"],
        )
        if sum(values) != summary["n"]:
            raise ValueError("Action counts do not sum to fixture count")
        left = 0
        for value, color in zip(values, colors):
            if value:
                ax.barh(index, value, left=left, height=0.55, color=color)
                ax.text(
                    left + value / 2,
                    index,
                    str(value),
                    ha="center",
                    va="center",
                    weight="bold",
                    color=NAVY if color == REVIEW else "white",
                    fontsize=12,
                )
            left += value
    ax.set_yticks(
        range(len(rows)),
        [
            f"{TASK_NAMES[task['task']]} · {split}\n"
            f"{summary['n']} fixtures / {groups(results, task['task'], split)} groups"
            for task, split, summary in rows
        ],
    )
    ax.tick_params(axis="y", pad=16, labelsize=10)
    ax.invert_yaxis()
    largest = max(summary["n"] for _, _, summary in rows)
    ax.set_xlim(0, largest)
    ax.set_xticks(range(largest + 1))
    ax.set_xlabel("Number of authored fixtures")
    ax.set_axisbelow(True)
    ax.grid(axis="x", color=GRID, linewidth=0.7)
    ax.spines["left"].set_visible(False)
    fig.legend(
        handles=[
            Patch(color=TEAL, label="Reference-correct suggested act"),
            Patch(color=ROSE, label="Wrong suggested act"),
            Patch(color=REVIEW, label="Review"),
            Patch(color=NAVY, label="Refuse"),
        ],
        loc="upper left",
        bbox_to_anchor=(0.06, 0.805),
        ncol=4,
        frameon=False,
        fontsize=9,
        handlelength=1.1,
        columnspacing=2,
    )
    fig.text(
        0.06,
        0.105,
        f"{acts}/{n} suggested acts ({acts / n:.1%})"
        f"     ·     {wrong} wrong suggested acts"
        f"     ·     {actual} actual acts",
        fontsize=12,
        weight="bold",
    )
    fig.text(
        0.06,
        0.052,
        "Authored labels and related variants do not establish a population error rate."
        " Zero observed errors is not guaranteed safety.",
        fontsize=9,
        color=MUTED,
    )
    save(fig, output, "action-mix")


def plot_validation(results: dict, output: Path) -> None:
    n = sum(task["validation"]["n"] for task in results["byTask"])
    n_groups = groups(results, split="validation")
    scored = sum(
        bin_["n"]
        for task in results["byTask"]
        for bin_ in task["validation"]["reliability"]
    )
    fig, (risk, calibration) = plt.subplots(1, 2, figsize=(12.5, 7.3))
    fig.subplots_adjust(left=0.08, right=0.965, top=0.715, bottom=0.245, wspace=0.3)
    heading(
        fig,
        f"{backend_label(results)} / VALIDATION ONLY",
        "Coverage is a choice; probability needs evidence",
        f"{n} authored fixtures / {n_groups} related groups"
        f"  |  {scored} model-scored cases; deterministic floors omitted from calibration",
    )
    risk.set_title("Suggested-act risk versus coverage", loc="left", pad=15)
    calibration.set_title("P(yes) calibration, with bin counts", loc="left", pad=15)
    max_error = 0.05
    for index, task in enumerate(results["byTask"]):
        summary = task["validation"]
        color = TASK_COLORS[task["task"]]
        name = TASK_NAMES[task["task"]]
        points = sorted(
            {
                (point["coverage"], point["errorRate"])
                for point in summary["curve"]
                if point["acts"] > 0 and point["errorRate"] is not None
            }
        )
        if points:
            xs, ys = zip(*points)
            max_error = max(max_error, *ys)
            risk.plot(xs, ys, "-o", color=color, linewidth=2.2, markersize=5, label=name)
        if summary["suggestedActs"]:
            coverage = summary["suggestedActs"] / summary["n"]
            error = summary["wrongSuggestedActs"] / summary["suggestedActs"]
            risk.scatter(
                [coverage], [error], marker="D", s=95, color=color,
                edgecolor="white", linewidth=1.2, zorder=5,
            )
            risk.annotate(
                f"{name} · bar {task['candidate']['actAbove']:.2f}\n"
                f"{summary['suggestedActs']} suggested / "
                f"{summary['wrongSuggestedActs']} wrong",
                xy=(coverage, error),
                xytext=(0.03 + index * 0.49, 0.91),
                textcoords="axes fraction",
                color=color,
                fontsize=9,
                va="top",
                arrowprops={"arrowstyle": "-", "color": color, "lw": 0.9},
            )
        for bin_ in summary["reliability"]:
            if bin_["n"] == 0:
                continue
            x, y = bin_["meanConfidence"], bin_["accuracy"]
            calibration.scatter(
                [x], [y], s=65 + bin_["n"] * 10,
                color=color, edgecolor="white", linewidth=1.2, zorder=4,
                marker="o" if index == 0 else "s",
            )
            # Fixed outward offsets keep neighboring high-probability bins distinct.
            offset = (-13, -23) if x > 0.5 and index == 0 else (7, -23 if y > 0.8 else 10)
            calibration.annotate(
                f"n={bin_['n']}", (x, y), xytext=offset,
                textcoords="offset points", color=color, fontsize=9, weight="bold",
                ha="right" if x > 0.5 and index == 0 else "left",
            )
    risk.set_xlim(-0.025, 1.025)
    risk.set_ylim(-0.04, min(1.05, max_error + 0.12))
    risk.set_xlabel("Share of all validation fixtures suggested to act")
    risk.set_ylabel("Wrong share among suggested acts")
    risk.xaxis.set_major_formatter(PercentFormatter(1))
    risk.yaxis.set_major_formatter(PercentFormatter(1))
    calibration.plot([0, 1], [0, 1], linestyle="--", color=GRID, linewidth=1.5)
    calibration.set_xlim(-0.045, 1.045)
    calibration.set_ylim(-0.08, 1.1)
    calibration.set_xlabel("Predicted probability action is correct")
    calibration.set_ylabel("Observed eligible share")
    calibration.xaxis.set_major_formatter(PercentFormatter(1))
    calibration.yaxis.set_major_formatter(PercentFormatter(1))
    for axis in (risk, calibration):
        axis.grid(color=GRID, linewidth=0.65)
        axis.set_axisbelow(True)
    fig.legend(
        handles=[
            Line2D([0], [0], color=TASK_COLORS[t["task"]], marker="o",
                   linewidth=2, label=TASK_NAMES[t["task"]])
            for t in results["byTask"]
        ],
        loc="upper left", bbox_to_anchor=(0.06, 0.805), ncol=2, frameon=False,
        fontsize=10,
    )
    fig.text(
        0.06, 0.12,
        "Diamonds mark policies frozen from fit groups. Curves are descriptive replays,"
        " not a second threshold-selection pass.",
        fontsize=9, color=MUTED,
    )
    fig.text(
        0.06, 0.077,
        "Empty bins and zero-act risks are omitted. Observed eligible share is the"
        " reference-positive fraction, not leading-answer accuracy.",
        fontsize=9, color=MUTED,
    )
    fig.text(
        0.06, 0.034,
        "Related authored cases supply no production confidence bound."
        " A zero-error point does not guarantee safety.",
        fontsize=9, color=MUTED,
    )
    save(fig, output, "validation-diagnostics")


def plot_evidence(evidence: dict, output: Path) -> None:
    target = evidence["targetAccuracy"]
    trials = evidence["trials"]
    rows = sorted(evidence["rows"], key=lambda row: row["trueAccuracy"])
    x = [row["trueAccuracy"] for row in rows]
    series = {
        method["id"]: [
            next(item["acceptanceRate"] for item in row["results"]
                 if item["methodId"] == method["id"])
            for row in rows
        ]
        for method in evidence["methods"]
    }
    panels = [
        ("200 labels: point estimate versus exact bound",
         [("point200", "Point estimate, one look", ROSE),
          ("exact200", "Exact bound, one look", TEAL)]),
        ("2,000-label budget: one look versus repeated looks",
         [("exact2000", "Exact bound, one look", TEAL),
          ("repeatedExact2000", "Exact bound, uncorrected repeated looks", ROSE)]),
    ]
    fig, axes = plt.subplots(1, 2, figsize=(12.5, 7.4))
    fig.subplots_adjust(left=0.075, right=0.965, top=0.69, bottom=0.235, wspace=0.2)
    heading(
        fig, "SEEDED SIMULATION / INDEPENDENT BERNOULLI LABELS",
        "The evidence rule changes the chance of acceptance",
        f"{trials:,} Monte Carlo trials per true accuracy · seed {evidence['seed']} · "
        f"illustrative target {target:.0%}, one-sided confidence {evidence['confidence']:.0%}",
    )
    for axis, (title, methods) in zip(axes, panels):
        axis.set_title(title, loc="left", fontsize=10.5, pad=52)
        axis.axvspan(min(x) - 0.003, target, color=ROSE, alpha=0.075, linewidth=0)
        axis.axvline(target, color=MUTED, linestyle=":", linewidth=1.2)
        for method_id, label, color in methods:
            axis.plot(
                x, series[method_id], "-o", color=color, linewidth=2.3,
                markersize=5, label=label,
            )
        axis.text(
            0.025, 0.94, f"Below target: true accuracy < {target:.0%}",
            transform=axis.transAxes, fontsize=8.5, color=ROSE, va="top",
        )
        axis.set_xlim(min(x) - 0.003, max(x) + 0.003)
        axis.set_ylim(-0.035, 1.06)
        axis.set_xticks([0.9, 0.95, 0.98, 0.995])
        axis.set_xticklabels(["90%", "95%", "98%", "99.5%"])
        axis.set_xlabel("True accuracy of the fixed candidate")
        axis.yaxis.set_major_formatter(PercentFormatter(1))
        axis.grid(axis="y", color=GRID, linewidth=0.65)
        axis.set_axisbelow(True)
        axis.legend(
            loc="lower left", bbox_to_anchor=(0, 1.01),
            frameon=False, fontsize=8.5, borderaxespad=0,
        )
        boundary = next((i for i, value in enumerate(x) if abs(value - target) < 1e-12), None)
        if boundary is not None:
            labels = [f"{series[method_id][boundary]:.1%}" for method_id, _, _ in methods]
            axis.text(
                0.025, 0.83, f"At the {target:.0%} boundary:\n"
                f"{labels[0]} vs {labels[1]} acceptance",
                transform=axis.transAxes, fontsize=10, weight="bold", va="top",
            )
    axes[0].set_ylabel("Trials accepting the candidate")
    fig.text(
        0.06, 0.12,
        "Matched maximum label budgets within each panel. Repeated looks check every"
        " 20 labels and stop on acceptance.",
        fontsize=9, color=MUTED,
    )
    fig.text(
        0.06, 0.077,
        "Acceptance below the target is a false promotion; acceptance exactly at the"
        " target is a boundary event. Repeated bounds are uncorrected.",
        fontsize=9, color=MUTED,
    )
    fig.text(
        0.06, 0.034,
        "This simulation assumes independent labels for a fixed candidate."
        " Its confidence guarantee does not transfer to the authored pilot corpus.",
        fontsize=9, color=MUTED,
    )
    save(fig, output, "evidence-rules")


def write_report(results: dict, evidence: dict, sources: list, run: Path, output: Path) -> None:
    heldout = [row for row in results["cases"] if row["split"] != "fit"]
    acts = [row for row in heldout if row["recommendation"] == "act"]
    wrong = sum(not row["truth"] for row in acts)
    actual = sum(row["actualAction"] == "act" for row in heldout)
    related_groups = len({row["group"] for row in heldout})
    rows = []
    for task in results["byTask"]:
        for split in ("validation", "challenge"):
            summary = task[split]
            rows.append(
                "<tr>"
                f"<td>{escape(TASK_NAMES[task['task']])}</td><td>{escape(split)}</td>"
                f"<td>{summary['n']} / {groups(results, task['task'], split)}</td>"
                f"<td>{summary['suggestedActs']}</td><td>{summary['wrongSuggestedActs']}</td>"
                f"<td>{summary['suggestedReviews']}</td><td>{summary['suggestedRefusals']}</td>"
                f"<td>{summary['actualActs']}</td></tr>"
            )
    candidates = "".join(
        "<li>"
        f"<strong>{escape(TASK_NAMES[c['task']])}</strong>: act at P(yes) ≥ {c['actAbove']:.2f}; "
        f"{c['fitRows']} eligible scored fit rows; {c['fitActs']} fitted acts. "
        f"{candidate_fingerprint(c)}.</li>"
        for c in results["candidates"]
    )
    source_items = []
    for source in sources:
        parsed = urlsplit(source["url"])
        if parsed.scheme not in ("https", "http"):
            raise ValueError(f"Unsupported source URL scheme: {parsed.scheme}")
        source_items.append(
            f'<li><a href="{escape(source["url"])}">{escape(source["title"])}</a>'
            f' — {escape(source["whatItSupports"])}</li>'
        )
    file_items = "".join(
        f'<a href="{local_link(run / filename, output)}">{escape(filename)}</a>'
        for filename in ("manifest.json", "ledger.jsonl", "results.json", "evidence.json", "sources.json")
    )
    case_rows = "".join(
        "<tr>"
        f"<td><code>{escape(row['id'])}</code></td>"
        f"<td>{escape(row['split'])}</td>"
        f"<td>{'Yes' if row['truth'] else 'No'}</td>"
        f"<td>{'—' if row['go'] is None else f'{row['go']:.2f}'}</td>"
        f"<td>{escape(row['recommendation'])}</td>"
        f"<td>{escape(row['reason'])}</td></tr>"
        for row in results["cases"]
    )
    evidence_rows = "".join(
        "<tr>" + f"<td>{row['trueAccuracy']:.1%}</td>"
        + "".join(
            f"<td>{next(item['acceptanceRate'] for item in row['results'] if item['methodId'] == method):.2%}</td>"
            for method in ("point200", "exact200", "exact2000", "repeatedExact2000")
        ) + "</tr>"
        for row in evidence["rows"]
    )
    model = ", ".join(results["modelsObserved"]) or results["requestedModel"]
    report = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ratchet · Shadow pilot evidence</title>
<style>
:root {{color-scheme:light;--ink:{NAVY};--muted:{MUTED};--teal:{TEAL};--line:{GRID};}}
* {{box-sizing:border-box}} body {{margin:0;background:#f5f7fa;color:var(--ink);
font:16px/1.65 "Segoe UI",system-ui,sans-serif}} main {{max-width:1220px;margin:auto;padding:56px 32px}}
header {{border-top:5px solid var(--teal);padding-top:24px;margin-bottom:28px}}
.eyebrow {{font-size:12px;font-weight:750;letter-spacing:.13em;text-transform:uppercase;color:var(--teal)}}
h1 {{font-size:clamp(32px,4vw,48px);line-height:1.15;letter-spacing:-.025em;margin:14px 0}}
h2 {{font-size:24px;line-height:1.3;margin:0 0 14px}} p {{margin:12px 0}}
.lede {{font-size:19px;max-width:900px;color:var(--muted)}} .meta {{font-size:13px;color:var(--muted)}}
.cards {{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}}
.card,section {{background:white;border:1px solid var(--line);border-radius:12px}}
.card {{padding:22px}} .number {{font-size:36px;font-weight:700;line-height:1.2}}
.label {{font-size:13px;color:var(--muted);margin-top:6px}} section {{padding:28px;margin:24px 0}}
.note {{border-left:4px solid var(--teal);background:#edf6f5;padding:15px 20px;border-radius:3px}}
figure {{margin:10px -12px 14px}} img {{display:block;width:100%;height:auto}}
figcaption {{font-size:13px;color:var(--muted);padding:0 12px}} a {{color:#1d6883;text-underline-offset:3px}}
.downloads {{display:flex;gap:18px;flex-wrap:wrap;font-size:14px}}
.table-wrap {{overflow:auto}} table {{width:100%;border-collapse:collapse;font-size:14px}}
th {{text-align:left;font-weight:650;background:#f1f5f9}} th,td {{padding:12px;border-bottom:1px solid var(--line);
vertical-align:top}} td:nth-child(n+3) {{font-variant-numeric:tabular-nums}}
ul {{padding-left:22px}} li {{margin:8px 0}} code {{font-size:.88em;overflow-wrap:anywhere}}
summary {{cursor:pointer;font-weight:650}} footer {{color:var(--muted);font-size:13px;margin-top:32px}}
@media(max-width:700px) {{main {{padding:24px 14px}}section {{padding:18px}} .cards {{grid-template-columns:repeat(2,1fr)}}
.card {{padding:16px}}.number {{font-size:28px}}}} @media print {{body {{background:white}}main {{padding:0}}
section {{break-inside:avoid}}.downloads {{display:none}}}}
</style></head><body><main>
<header><div class="eyebrow">Ratchet / {escape(backend_label(results))} / Authored fixtures</div>
<h1>Tool gating and output verification</h1>
<p class="lede">A visible record of proposed decisions, frozen candidate policies,
and the evidence needed before an application can earn automation.</p>
<p class="meta">Model: <code>{escape(model)}</code> · Recorded {escape(results['generatedAt'])} ·
Corpus <code>{escape(results['corpusHash'])}</code></p></header>
<div class="cards">
<div class="card"><div class="number">{len(heldout)}</div><div class="label">held-out authored fixtures / {related_groups} groups</div></div>
<div class="card"><div class="number">{len(acts)}</div><div class="label">suggested acts / {len(acts)/len(heldout):.1%} of held-out cases</div></div>
<div class="card"><div class="number">{wrong}</div><div class="label">wrong suggested acts against authored labels</div></div>
<div class="card"><div class="number">{actual}</div><div class="label">actual acts / enforcement {escape(results['enforcement'])}</div></div>
</div>
<div class="note"><strong>Evidence status: insufficient for production enforcement.</strong>
These related, authored cases are an engineering exercise. They do not provide a population
error bound, real review savings, or independent human validation. Zero observed errors is
not guaranteed safety.</div>
<section><h2>What the application would do</h2>
<p>Every fixture stayed in shadow mode. The tables distinguish the policy recommendation from
the application's actual action. Validation and challenge groups were excluded from fitting.</p>
<figure><img src="action-mix.png" alt="Suggested actions for validation and challenge cases by task">
<figcaption><a href="action-mix.svg">Download vector chart</a> · Counts include deterministic floors.</figcaption></figure>
<div class="table-wrap"><table><thead><tr><th>Task</th><th>Split</th><th>Fixtures / groups</th>
<th>Suggested acts</th><th>Wrong acts</th><th>Review</th><th>Refuse</th><th>Actual acts</th>
</tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p class="meta">Across all {results['total']['n']} fixtures: {results['requests']} model requests,
${results['billedUsd']:.6f} recorded cost, {results['total']['floors']} code-owned floors,
{results['total']['failedOpen']} fail-open decisions. Recorded cost is not a prepaid spending guarantee.</p>
</section>
<section><h2>Frozen policy diagnostics</h2><ul>{candidates}</ul>
<figure><img src="validation-diagnostics.png" alt="Validation-only risk coverage and P yes calibration with bin counts">
<figcaption><a href="validation-diagnostics.svg">Download vector chart</a> · No confidence intervals are
computed from these correlated authored fixtures.</figcaption></figure>
<p>The curves replay stored probabilities at different bars. They are descriptive and must not
be used to select another candidate while claiming the same validation set is fresh.
Calibration uses P(yes): the observed share is the reference-positive fraction within a
probability bin, not the accuracy of the model's leading answer. Empty bins and risks with
zero suggested acts are unknown and omitted.</p></section>
<section><div class="eyebrow">Separate seeded simulation</div><h2>Why the acceptance rule matters</h2>
<p>This experiment uses independent Bernoulli labels for fixed candidates. It is separate
from the live model and the authored corpus. The {evidence['targetAccuracy']:.0%} target is
illustrative; no production risk tolerance has been agreed.</p>
<figure><img src="evidence-rules.png" alt="Matched-budget acceptance comparison for fixed and repeated statistical looks">
<figcaption><a href="evidence-rules.svg">Download vector chart</a> · {evidence['trials']:,} trials per
true accuracy; seed {evidence['seed']}; one-sided confidence {evidence['confidence']:.0%}.</figcaption></figure>
<div class="table-wrap"><table><thead><tr><th>True accuracy</th><th>Point / 200 labels</th>
<th>Exact / 200 labels</th><th>Exact / 2,000 labels</th><th>Repeated exact / 2,000 budget</th>
</tr></thead><tbody>{evidence_rows}</tbody></table></div>
<p>The table reports acceptance frequency. Acceptance at the target is a boundary event;
acceptance below it is a false promotion. Repeated looks check every 20 labels and stop on
acceptance without a multiple-look correction. Budgets are matched within each chart panel;
an early acceptance can use fewer labels. The fixed-look guarantee assumes independent,
representative outcomes for a frozen policy and a preplanned evaluation.</p></section>
<section><h2>Provenance and reproducibility</h2>
<p>{escape(results['labelOrigin'])}. Fictional execution receipts are assumptions of the
scenarios. A real integration must obtain them from authenticated execution records.
The proposed shell commands, refunds, messages, and deployments were never executed.</p>
<p>Families remain together across fit, validation, and challenge splits. The variants in a
family are correlated; a group split reduces template leakage but does not establish
independence or representativeness. Source documents support tool semantics, not the labels.</p>
<div class="downloads">{file_items}</div>
<details><summary>Inspect all {len(results['cases'])} authored fixture outcomes</summary>
<div class="table-wrap"><table><thead><tr><th>Fixture</th><th>Split</th><th>Reference yes</th>
<th>P(yes)</th><th>Suggested</th><th>Authored rationale</th></tr></thead>
<tbody>{case_rows}</tbody></table></div></details>
<h2 style="margin-top:28px">Primary sources</h2><ul>{''.join(source_items)}</ul>
</section><footer>Generated locally from saved JSON. Charts require no network access.
Model judgments, authored references, and the independent-label simulation are different
forms of evidence and are presented separately.</footer></main></body></html>"""
    (output / "report.html").write_text(report, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("output_dir", type=Path, nargs="?")
    args = parser.parse_args()
    run = args.run_dir.resolve(strict=True)
    output = (args.output_dir or run).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = read_json(run / "results.json")
    evidence = read_json(run / "evidence.json")
    sources = read_json(run / "sources.json")
    configure_style()
    plot_actions(results, output)
    plot_validation(results, output)
    plot_evidence(evidence, output)
    write_report(results, evidence, sources, run, output)
    print(output / "report.html")
    for stem in ("action-mix", "validation-diagnostics", "evidence-rules"):
        print(output / f"{stem}.png")


if __name__ == "__main__":
    main()
