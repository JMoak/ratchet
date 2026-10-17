/**
 * Helpers for decision models inside control loops (games, browsers, streams, UI reflexes).
 * The live record says loops fail in three recurring ways: the action flips every tick on a
 * probability that hovers near the bar, a late answer is applied to a state that has already
 * changed, and the same state is re-asked at every tick. Hysteresis, freshness and leases
 * (see `cached` with ttl and maxUses) are the fixes, and they belong in code, not the model.
 */

export interface HysteresisOptions {
  /** Switch on when the probability reaches this. */
  readonly enterAbove: number;
  /** Switch off only when the probability falls to this or below. Must be below enterAbove. */
  readonly exitBelow: number;
  /** Hold a state for at least this many updates before it may switch. Default 1. */
  readonly minTicks?: number;
}

/**
 * Two-threshold switching with a minimum dwell, applied to the probability (or the margin),
 * never to a vendor confidence figure. Prevents the target-flipping-every-tick failure.
 */
export class Hysteresis {
  private on = false;
  private ticksInState = 0;
  constructor(private readonly opts: HysteresisOptions) {
    if (opts.exitBelow >= opts.enterAbove) throw new Error("exitBelow must be below enterAbove");
  }

  get state(): boolean {
    return this.on;
  }

  update(p: number): boolean {
    const min = Math.max(1, this.opts.minTicks ?? 1);
    this.ticksInState++;
    if (this.ticksInState < min) return this.on;
    if (!this.on && p >= this.opts.enterAbove) {
      this.on = true;
      this.ticksInState = 0;
    } else if (this.on && p <= this.opts.exitBelow) {
      this.on = false;
      this.ticksInState = 0;
    }
    return this.on;
  }
}

/**
 * Sequence and fingerprint tracking for overlapped requests. Sample the state, take a ticket,
 * and when the answer comes back accept it only if no newer state has been sampled since
 * (or, with `fingerprint`, only if the state has not actually changed). Also says whether
 * the state changed at all, so unchanged states need not be re-asked.
 */
export class Freshness {
  private seq = 0;
  private lastFingerprint: string | undefined;
  private fingerprints = new Map<number, string>();

  /** Register a newly sampled state. */
  ticket(fingerprint: string): { readonly seq: number; readonly changed: boolean } {
    const changed = fingerprint !== this.lastFingerprint;
    this.lastFingerprint = fingerprint;
    this.seq++;
    this.fingerprints.set(this.seq, fingerprint);
    if (this.fingerprints.size > 1024) {
      const oldest = this.fingerprints.keys().next().value;
      if (oldest !== undefined) this.fingerprints.delete(oldest);
    }
    return { seq: this.seq, changed };
  }

  /** Is an answer for ticket `seq` still applicable? */
  accept(seq: number, opts: { readonly sameStateOnly?: boolean } = {}): boolean {
    if (opts.sameStateOnly) {
      const fp = this.fingerprints.get(seq);
      return fp !== undefined && fp === this.lastFingerprint;
    }
    return seq === this.seq;
  }

  get latest(): number {
    return this.seq;
  }
}
