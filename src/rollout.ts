import type { Engine } from "./engine.ts";
import type { Gate } from "./gate.ts";
import { isUnselected } from "./ledger/calibration.ts";
import { type DecisionRecord, decisionRows, type Ledger, type Mode } from "./ledger/ledger.ts";

/**
 * Shadow to enforce, and back, on evidence. The best field implementation seen (stuntd) runs
 * a minimum shadow period, promotes when the engine would have been right often enough on
 * the rows it would have acted on, keeps a continuous blind audit live, and demotes to shadow
 * the moment the audited error rate breaks the promise. This controller does exactly that
 * from the ledger. Call `evaluate()` on a schedule or after each batch of labels.
 *
 * Per gate is the normal use: a promise is about one decision point, so the controller reads
 * only that gate's decision rows (a battery's combined rows, never its members) and flips
 * only that gate's mode. Engine-level use reads every decision row and flips `engine.mode`,
 * which every gate without a pinned mode follows.
 */
export interface RolloutSettings {
  /** Restrict to one question id; default all. */
  readonly questionId?: string;
  /** Most recent labelled, unselected rows considered. Default 200. */
  readonly window?: number;
  /** Labelled shadow rows needed before promotion. Default 100. */
  readonly minShadowRows?: number;
  /** Labelled audit rows needed before a live engine can be judged. Default 30. */
  readonly minAuditRows?: number;
  /** Rows with soft == "act" needed in the window to judge the acted slice. Default 20. */
  readonly minActed?: number;
  readonly now?: () => string;
}

export type RolloutOptions = RolloutSettings & {
  /** Accuracy promised on rows the engine acts on, e.g. 0.98. */
  readonly promisedAccuracy: number;
} & (
    | {
        /** Engine-level: every decision row, and `engine.mode`. */
        readonly engine: Engine;
      }
    | {
        /** Gate-level: this gate's decision rows, and `gate.mode`. */
        readonly gate: Gate;
      }
  );

export interface RolloutStatus {
  readonly mode: Mode;
  readonly changed: boolean;
  readonly reason: string;
  /** Labelled rows examined, acted-slice size, and its accuracy. */
  readonly window: { readonly n: number; readonly acted: number; readonly accuracy: number };
  readonly promisedAccuracy: number;
  /** The gate this controller rolls out; absent for engine-level use. */
  readonly gateId?: string;
  readonly at: string;
}

interface Target {
  readonly ledger: Ledger;
  readonly gateId: string | undefined;
  readonly mode: () => Mode;
  readonly setMode: (m: Mode) => void;
}

export class Rollout {
  readonly history: RolloutStatus[] = [];
  constructor(private readonly opts: RolloutOptions) {}

  private target(): Target {
    const o = this.opts;
    if ("gate" in o) {
      const g = o.gate;
      return {
        ledger: g.engine.ledger,
        gateId: g.id,
        mode: () => g.mode,
        setMode: (m) => {
          g.mode = m;
        },
      };
    }
    const e = o.engine;
    return {
      ledger: e.ledger,
      gateId: undefined,
      mode: () => e.mode,
      setMode: (m) => {
        e.mode = m;
      },
    };
  }

  private select(
    rows: readonly DecisionRecord[],
    audited: boolean,
    gateId: string | undefined,
  ): DecisionRecord[] {
    const q = this.opts.questionId;
    const window = this.opts.window ?? 200;
    return decisionRows(rows)
      .filter((r) => r.outcome && !r.failedOpen)
      .filter((r) => (gateId !== undefined ? r.gateId === gateId : true))
      .filter((r) => (q ? r.questionId === q : true))
      .filter((r) => (audited ? r.tags.includes("audit") : isUnselected(r)))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-window);
  }

  private actedAccuracy(rows: readonly DecisionRecord[]): { acted: number; accuracy: number } {
    const acted = rows.filter((r) => r.soft === "act");
    const right = acted.filter((r) => r.outcome?.correct).length;
    return { acted: acted.length, accuracy: acted.length ? right / acted.length : 0 };
  }

  async evaluate(): Promise<RolloutStatus> {
    const target = this.target();
    const promised = this.opts.promisedAccuracy;
    const at = (this.opts.now ?? (() => new Date().toISOString()))();
    const rows = await target.ledger.all();
    const minActed = this.opts.minActed ?? 20;
    const gate = target.gateId !== undefined ? { gateId: target.gateId } : {};
    let status: RolloutStatus;
    if (target.mode() === "shadow") {
      const shadow = this.select(rows, false, target.gateId);
      const { acted, accuracy } = this.actedAccuracy(shadow);
      const enough = shadow.length >= (this.opts.minShadowRows ?? 100) && acted >= minActed;
      if (enough && accuracy >= promised) {
        target.setMode("enforce");
        status = {
          mode: "enforce",
          changed: true,
          reason: `promoted: ${acted} shadow acts at ${(100 * accuracy).toFixed(1)}% >= promised ${(100 * promised).toFixed(1)}%`,
          window: { n: shadow.length, acted, accuracy },
          promisedAccuracy: promised,
          ...gate,
          at,
        };
      } else {
        status = {
          mode: "shadow",
          changed: false,
          reason: enough
            ? `holding: shadow acts at ${(100 * accuracy).toFixed(1)}% below promised ${(100 * promised).toFixed(1)}%`
            : `holding: ${shadow.length} labelled shadow rows, ${acted} acts; need ${this.opts.minShadowRows ?? 100} and ${minActed}`,
          window: { n: shadow.length, acted, accuracy },
          promisedAccuracy: promised,
          ...gate,
          at,
        };
      }
    } else {
      const audits = this.select(rows, true, target.gateId);
      const { acted, accuracy } = this.actedAccuracy(audits);
      const enough = audits.length >= (this.opts.minAuditRows ?? 30);
      if (enough && accuracy < promised) {
        target.setMode("shadow");
        status = {
          mode: "shadow",
          changed: true,
          reason: `demoted: ${acted} audited acts at ${(100 * accuracy).toFixed(1)}% below promised ${(100 * promised).toFixed(1)}%`,
          window: { n: audits.length, acted, accuracy },
          promisedAccuracy: promised,
          ...gate,
          at,
        };
      } else {
        status = {
          mode: "enforce",
          changed: false,
          reason: enough
            ? `live: audited acts at ${(100 * accuracy).toFixed(1)}%`
            : `live: ${audits.length} audited rows, need ${this.opts.minAuditRows ?? 30} to judge`,
          window: { n: audits.length, acted, accuracy },
          promisedAccuracy: promised,
          ...gate,
          at,
        };
      }
    }
    this.history.push(status);
    return status;
  }
}
