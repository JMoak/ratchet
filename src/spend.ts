import { type DecisionRecord, isValidCost, type Ledger } from "./ledger/ledger.ts";

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
 *
 * An unknown cost is never counted as free, and a cost that is not a finite non-negative number
 * never lowers or freezes the day's spend (e2e T4-05, T4-06): it is counted at `estimateUsd()`,
 * the larger of the reservation and the costliest request on record. With neither (a fresh
 * ledger and no `reserveUsd`), there is nothing to price it by, and the day stops admitting
 * requests until a priced request gives it a price. Set `reserveUsd` to avoid that.
 */
export interface DailyBudgetOptions {
  /** USD a UTC day may record before new requests fail open. */
  readonly capUsd: number;
  /**
   * Reserved for each request in flight, and the price of a request whose cost is unknown when
   * it is the larger. Default: the most any one request in the ledger has cost, which is zero
   * on a fresh ledger; set it to bound a first burst of concurrent calls.
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
  /**
   * Requests today whose cost is unknown and had nothing to price them by. While any are
   * outstanding the day admits nothing; absent when there are none.
   */
  readonly unpricedRequests?: number;
}

/** Room held for one admitted request until its rows are written. */
export interface Reservation {
  readonly usd: number;
}

/** What `record` needs of a row to count it once and price it: all optional. */
export type RecordedRow = Partial<Pick<DecisionRecord, "id" | "requestId" | "costEstimate">>;

/** A cost recorded while the day's spend was loading or before it was loaded. */
interface Pending {
  readonly id: string | undefined;
  readonly cost: number;
  readonly unpriced: string | undefined;
}

export class DailySpend {
  private day: string | undefined;
  private spent = 0;
  private reserved = 0;
  private largest = 0;
  private loading: Promise<void> | undefined;
  /** True from the moment a load reads the ledger until it has counted what arrived meanwhile. */
  private inLoad = false;
  private pending: Pending[] = [];
  /** Today's requests with an unknown cost and no price to count it at, by request id. */
  private unpriced = new Set<string>();
  private anonymous = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly opts: DailyBudgetOptions,
  ) {
    if (!(Number.isFinite(opts.capUsd) && opts.capUsd > 0)) {
      throw new Error("dailyBudgetUsd must be a positive number of USD");
    }
    if (opts.reserveUsd !== undefined && !isValidCost(opts.reserveUsd)) {
      throw new Error("reserveUsd must be a non-negative number of USD");
    }
  }

  /**
   * What an unknown cost is counted at: the larger of `reserveUsd` and the costliest fully
   * priced request on record. Zero means there is nothing to price it by yet.
   */
  estimateUsd(): number {
    return Math.max(this.opts.reserveUsd ?? 0, this.largest);
  }

  /** The costliest fully priced request this day's reads and releases have seen. */
  get largestUsd(): number {
    return this.largest;
  }

  /** Room for one request, or undefined when it could carry the day past its cap. */
  async reserve(): Promise<Reservation | undefined> {
    await this.current();
    this.priceUnpriced();
    // An unknown cost with nothing to price it by: spending on would be spending blind.
    if (this.unpriced.size > 0) return undefined;
    const usd = this.opts.reserveUsd ?? this.largest;
    const cap = this.opts.capUsd;
    // Sums of float costs drift (three 0.0001s exceed 0.0003), so compare to a nano-dollar.
    if (this.spent >= cap - NANO_USD || this.spent + this.reserved + usd > cap + NANO_USD) {
      return undefined;
    }
    this.reserved += usd;
    return { usd };
  }

  /**
   * Give a request's room back once its rows are written; its cost is recorded row by row.
   * `requestCostUsd` is the part of its cost that was reported validly, which is what the
   * default reservation learns from; an estimate never teaches it.
   */
  release(reservation: Reservation, requestCostUsd: number): void {
    this.reserved = Math.max(0, this.reserved - reservation.usd);
    if (isValidCost(requestCostUsd)) this.largest = Math.max(this.largest, requestCostUsd);
    this.priceUnpriced();
  }

  /**
   * A row was written: count its cost toward the day. A cost that is not a finite non-negative
   * number is counted at `estimateUsd()` instead, never as a refund or a NaN. A row whose
   * `costEstimate` says there was nothing to price it by holds the day shut until there is.
   * A cost recorded while the day's spend is loading, or after the clock has passed into a day
   * not yet loaded, is counted once that load completes, unless the load already read the row
   * (e2e T4-12): nothing recorded is lost to a load that started before its row was written.
   */
  record(costUsd: number, row: RecordedRow = {}): void {
    const valid = isValidCost(costUsd);
    const cost = valid ? costUsd : this.estimateUsd();
    const blind = row.costEstimate?.basis === "none" || (!valid && cost === 0);
    const unpriced = blind
      ? (row.requestId ?? row.id ?? `unpriced-${++this.anonymous}`)
      : undefined;
    if (this.inLoad || this.day !== dayOf(this.now())) {
      this.pending.push({ id: row.id, cost, unpriced });
      return;
    }
    this.spent += cost;
    if (unpriced !== undefined) this.unpriced.add(unpriced);
  }

  async snapshot(): Promise<SpendSnapshot> {
    await this.current();
    this.priceUnpriced();
    return {
      day: this.day ?? dayOf(this.now()),
      spentUsd: this.spent,
      reservedUsd: this.reserved,
      capUsd: this.opts.capUsd,
      ...(this.unpriced.size > 0 ? { unpricedRequests: this.unpriced.size } : {}),
    };
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** Once a price exists, count each unpriced request at it and reopen the day. */
  private priceUnpriced(): void {
    const usd = this.estimateUsd();
    if (this.unpriced.size === 0 || usd <= 0) return;
    this.spent += this.unpriced.size * usd;
    this.unpriced.clear();
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
   * spending sooner, not later. Rows of a request are summed to learn the largest request, from
   * validly reported costs only. A row whose cost is invalid, or an estimate made when nothing
   * could price it, is priced now at the larger of the reservation and that largest request.
   */
  private async load(day: string): Promise<void> {
    this.inLoad = true;
    try {
      const rows = await this.ledger.all();
      let spent = 0;
      const seen = new Set<string>();
      const perRequest = new Map<string, number>();
      const today = rows.filter((r) => {
        seen.add(r.id);
        if (isValidCost(r.cost) && r.costEstimate === undefined) {
          perRequest.set(r.requestId, (perRequest.get(r.requestId) ?? 0) + r.cost);
        }
        const at = Date.parse(r.at);
        return Number.isNaN(at) || dayOf(new Date(at)) === day;
      });
      for (const total of perRequest.values()) this.largest = Math.max(this.largest, total);
      // An unknown cost is a request's, so a request with several such rows is priced once.
      const blind = new Set<string>();
      for (const r of today) {
        if (isValidCost(r.cost)) spent += r.cost;
        if (!isValidCost(r.cost) || r.costEstimate?.basis === "none") blind.add(r.requestId);
      }
      const price = this.estimateUsd();
      const unpriced = price > 0 ? new Set<string>() : blind;
      if (price > 0) spent += blind.size * price;
      // Costs recorded while this load read the ledger, or before it began on a stale day.
      for (const p of this.pending) {
        if (p.id !== undefined && seen.has(p.id)) continue;
        spent += p.cost;
        if (p.unpriced !== undefined) unpriced.add(p.unpriced);
      }
      this.pending = [];
      this.day = day;
      this.spent = spent;
      this.unpriced = unpriced;
    } finally {
      this.inLoad = false;
    }
  }
}

const NANO_USD = 1e-9;

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
