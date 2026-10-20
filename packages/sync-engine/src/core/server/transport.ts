import type { PushBody } from "#core/protocol";
import type { PullResult } from "./server";

export type Transport = {
  pull(request: { cursor: string | null; nodeId: string; limit: number }): Promise<PullResult>;
  /** Rejects with `LocalClockAheadError` when the server refuses a delta as too far ahead. */
  push(request: PushBody): Promise<void>;
};
