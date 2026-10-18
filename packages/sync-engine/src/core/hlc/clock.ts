import { assertNodeId } from "./node-id";
import { HLCTimestamp, MAX_LOGICAL } from "./timestamp";

export type HybridLogicalClockOptions = {
  last?: HLCTimestamp | null;
  now?: () => number;
  maxDriftMs?: number;
};

export class ClockDriftError extends Error {
  readonly remote: HLCTimestamp;
  readonly wallTime: number;

  constructor(remote: HLCTimestamp, wallTime: number) {
    super(
      `Remote timestamp ${remote.toString()} is ${remote.physicalTime - wallTime}ms ahead of local time`,
    );
    this.name = "ClockDriftError";
    this.remote = remote;
    this.wallTime = wallTime;
  }
}

export const DEFAULT_MAX_DRIFT_MS: number = 5 * 60_000;

/** Throws a `RangeError` naming `owner` if `maxDriftMs` is negative or NaN. */
export const assertMaxDriftMs = (maxDriftMs: number, owner: string): void => {
  if (maxDriftMs < 0 || Number.isNaN(maxDriftMs)) {
    throw new RangeError(`Invalid ${owner} maxDriftMs: ${maxDriftMs}`);
  }
};

/** Throws `ClockDriftError` if `remote` is more than `maxDriftMs` ahead of `wallTime`. */
export const assertWithinDrift = (
  remote: HLCTimestamp,
  wallTime: number,
  maxDriftMs: number,
): void => {
  if (remote.physicalTime - wallTime > maxDriftMs) {
    throw new ClockDriftError(remote, wallTime);
  }
};

export class HybridLogicalClock {
  readonly nodeId: string;
  #physical: number;
  #logical: number;
  readonly #now: () => number;
  readonly #maxDriftMs: number;

  constructor(
    nodeId: string,
    {
      last = null,
      now = Date.now,
      maxDriftMs = DEFAULT_MAX_DRIFT_MS,
    }: HybridLogicalClockOptions = {},
  ) {
    assertNodeId(nodeId);
    assertMaxDriftMs(maxDriftMs, "HLC");

    this.nodeId = nodeId;
    this.#physical = last?.physicalTime ?? 0;
    this.#logical = last?.logicalTime ?? 0;
    this.#now = now;
    this.#maxDriftMs = maxDriftMs;
  }

  tick(): HLCTimestamp {
    const wallTime = this.#now();

    if (wallTime > this.#physical) {
      this.#set(wallTime, 0);
    } else {
      this.#set(this.#physical, this.#logical + 1);
    }

    return this.last();
  }

  /**
   * Merge a timestamp issued by another node's clock, such as one attached to
   * a change from the server. The result is greater than both this clock's
   * last value and the remote one.
   *
   * Only for other nodes' timestamps. To catch up to this node's own stored
   * clock, use observe().
   *
   * @throws ClockDriftError if the remote is more than maxDriftMs ahead of
   * local wall time. The clock is left unchanged.
   */
  receive(remote: HLCTimestamp): HLCTimestamp {
    const wallTime = this.#now();
    assertWithinDrift(remote, wallTime, this.#maxDriftMs);

    const physical = Math.max(wallTime, this.#physical, remote.physicalTime);
    let logical = 0;

    if (physical === this.#physical && physical === remote.physicalTime) {
      logical = Math.max(this.#logical, remote.logicalTime) + 1;
    } else if (physical === this.#physical) {
      logical = this.#logical + 1;
    } else if (physical === remote.physicalTime) {
      logical = remote.logicalTime + 1;
    }

    this.#set(physical, logical);
    return this.last();
  }

  /**
   * Catch up to a timestamp this node has already issued or seen (e.g. the
   * shared stored clock), without counting it as a new event. Lets several
   * contexts with the same nodeId (tabs, workers) act as one clock.
   *
   * Monotonic and idempotent. No drift check: the value was already
   * validated by tick()/receive(). Not for other nodes' timestamps; use
   * receive() for those.
   */
  observe(other: HLCTimestamp): void {
    if (
      other.physicalTime > this.#physical ||
      (other.physicalTime === this.#physical && other.logicalTime > this.#logical)
    ) {
      this.#physical = other.physicalTime;
      this.#logical = other.logicalTime;
    }
  }

  last(): HLCTimestamp {
    return new HLCTimestamp(this.#physical, this.#logical, this.nodeId);
  }

  toString(): string {
    return this.last().toString();
  }

  #set(physical: number, logical: number) {
    let nextPhysical = physical;
    let nextLogical = logical;

    // if logical counter gets exhausted, borrow from the future
    if (nextLogical > MAX_LOGICAL) {
      nextPhysical += 1;
      nextLogical = 0;
    }

    // validate before mutating so a bad wall time can't corrupt the clock
    const next = new HLCTimestamp(nextPhysical, nextLogical, this.nodeId);
    this.#physical = next.physicalTime;
    this.#logical = next.logicalTime;
  }
}
