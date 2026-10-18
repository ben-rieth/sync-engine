import { assertNodeId } from "./node-id";

export const MAX_LOGICAL = 9999;
export const MAX_PHYSICAL = 922_337_203_685_477;
const LOGICAL_FACTOR = 10_000n;
// nodeId is validated by the constructor
const PATTERN = /^(\d{15})\.(\d{4})\.(.+)$/;

const pad = (value: number, width: number) => value.toString().padStart(width, "0");

/** Orders HLC strings. Their fields are zero-padded, so string order is timestamp order. */
export const compareTimestamps = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

export class HLCTimestamp {
  readonly physicalTime: number;
  readonly logicalTime: number;
  readonly nodeId: string;

  constructor(physicalTime: number, logicalTime: number, nodeId: string) {
    if (!Number.isInteger(physicalTime) || physicalTime < 0 || physicalTime > MAX_PHYSICAL) {
      throw new RangeError(`Invalid HLC physical time: ${physicalTime}`);
    }

    if (!Number.isInteger(logicalTime) || logicalTime < 0 || logicalTime > MAX_LOGICAL) {
      throw new RangeError(`Invalid HLC logical time: ${logicalTime}`);
    }

    assertNodeId(nodeId);

    this.physicalTime = physicalTime;
    this.logicalTime = logicalTime;
    this.nodeId = nodeId;
  }

  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.physicalTime !== b.physicalTime) {
      return a.physicalTime < b.physicalTime ? -1 : 1;
    }

    if (a.logicalTime !== b.logicalTime) {
      return a.logicalTime < b.logicalTime ? -1 : 1;
    }

    // If physical and logical times are equal, compare node IDs for deterministic ordering
    if (a.nodeId !== b.nodeId) {
      return a.nodeId < b.nodeId ? -1 : 1;
    }

    return 0; // Completely equal
  }

  compare(other: HLCTimestamp): number {
    return HLCTimestamp.compare(this, other);
  }

  // '000000000000000.0000.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  toString(): string {
    return `${pad(this.physicalTime, 15)}.${pad(this.logicalTime, 4)}.${this.nodeId}`;
  }

  toBigInt(): bigint {
    return BigInt(this.physicalTime) * LOGICAL_FACTOR + BigInt(this.logicalTime);
  }

  static fromBigInt(value: bigint, nodeId: string): HLCTimestamp {
    return new HLCTimestamp(Number(value / LOGICAL_FACTOR), Number(value % LOGICAL_FACTOR), nodeId);
  }

  static tryParse(value: string): HLCTimestamp | null {
    const match = PATTERN.exec(value);
    if (!match) {
      return null;
    }

    try {
      return new HLCTimestamp(Number(match[1]), Number(match[2]), String(match[3]));
    } catch {
      return null;
    }
  }

  static parse(value: string): HLCTimestamp {
    const timestamp = HLCTimestamp.tryParse(value);
    if (!timestamp) {
      throw new TypeError(`Invalid HLC timestamp: ${value}`);
    }
    return timestamp;
  }
}
