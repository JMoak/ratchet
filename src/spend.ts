import type { Ledger } from "./ledger/ledger.ts";

/**
 * A spend cap per UTC day, read from the ledger. A process-lifetime counter starts at zero on
 * every restart, so a crash loop could spend its cap many times over in one day; the ledger is
 * the record that survives the restart. Before a request buys any answer it reserves an
 * estimate, and it releases the reservation once its rows are written, so concurrent requests
 * cannot all slip under the cap at once.
 *
 * This is a recorded-spend cutoff, not a prepaid budget. Costs are known only after a call, a
 * failed call can still be billed, a request can cost more than its reservation, and another
 * process writing the same ledger is seen only when the day's spend is next read (at the first
 * request of a day). Provider-side limits are the only hard guarantee.
 */
export interface DailyBudgetOptions {
  /** USD a UTC day may record before new requests fail open. */
  readonly capUsd: number;
  /**
   * Reserved for each request in flight. Default: the most any one request in the ledger has
   * cost, which is zero on a fresh ledger; set it to bound a first burst of concurrent calls.
   */
  readonly reserveUsd?: number;
  readonly now?: () => Date;
}

export interface SpendSnapshot {
  /** The UTC day, as YYYY-MM-DD. */
  readonly day: string;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly capUsd: number;
}

/** Room held for one admitted request until its rows are written. */
export interface Reservation {
  readonly usd: number;
}

export class DailySpend {
  private day: string | undefined;
  private spent = 0;
  private reserved = 0;
  private largest = 0;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly ledger: Ledger,
    private readonly opts: DailyBudgetOptions,
  ) {
    if (!(Number.isFinite(opts.capUsd) && opts.capUsd > 0)) {
      throw new Error("dailyBudgetUsd must be a positive number of USD");
    }
    if (
      opts.reserveUsd !== undefined &&
      !(Number.isFinite(opts.reserveUsd) && opts.reserveUsd >= 0)
    ) {
      throw new Error("reserveUsd must be a non-negative number of USD");
    }
  }

  /** Room for one request, or undefined when it could carry the day past its cap. */
  async reserve(): Promise<Reservation | undefined> {
    await this.current();
    const usd = this.opts.reserveUsd ?? this.largest;
    const cap = this.opts.capUsd;
    // Sums of float costs drift (three 0.0001s exceed 0.0003), so compare to a nano-dollar.
    if (this.spent >= cap - NANO_USD || this.spent + this.reserved + usd > cap + NANO_USD) {
      return undefined;
    }
    this.reserved += usd;
    return { usd };
  }

  /** Give a request's room back once its rows are written; its cost is recorded row by row. */
  release(reservation: Reservation, requestCostUsd: number): void {
    this.reserved = Math.max(0, this.reserved - reservation.usd);
    if (Number.isFinite(requestCostUsd)) this.largest = Math.max(this.largest, requestCostUsd);
  }

  /** A row was written: count its cost toward the day it was read for. */
  record(costUsd: number): void {
    if (Number.isFinite(costUsd)) this.spent += costUsd;
  }

  async snapshot(): Promise<SpendSnapshot> {
    await this.current();
    return {
      day: this.day ?? dayOf(this.now()),
      spentUsd: this.spent,
      reservedUsd: this.reserved,
      capUsd: this.opts.capUsd,
    };
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** Read the day's spend from the ledger the first time a day is seen. */
  private async current(): Promise<void> {
    const day = dayOf(this.now());
    while (this.day !== day) {
      this.loading ??= this.load(day).finally(() => {
        this.loading = undefined;
      });
      await this.loading;
    }
  }

  /**
   * A row whose timestamp does not parse counts toward today: an unreadable clock should stop
   * spending sooner, not later. Rows of a request are summed to learn the largest request.
   */
  private async load(day: string): Promise<void> {
    let spent = 0;
    const perRequest = new Map<string, number>();
    for (const r of await this.ledger.all()) {
      const cost = Number.isFinite(r.cost) ? r.cost : 0;
      perRequest.set(r.requestId, (perRequest.get(r.requestId) ?? 0) + cost);
      const at = Date.parse(r.at);
      if (Number.isNaN(at) || dayOf(new Date(at)) === day) spent += cost;
    }
    this.day = day;
    this.spent = spent;
    for (const total of perRequest.values()) this.largest = Math.max(this.largest, total);
  }
}

const NANO_USD = 1e-9;

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
