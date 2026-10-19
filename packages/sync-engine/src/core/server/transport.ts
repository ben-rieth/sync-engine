import type { Delta } from "#core/delta";
import type { PullResult } from "./server";

export type Transport = {
  pull(request: { cursor: string | null; nodeId: string; limit: number }): Promise<PullResult>;
  /** Rejects with `ClockDriftError` when the server refuses a delta as too far ahead. */
  push(request: { nodeId: string; deltas: Delta[] }): Promise<void>;
};
