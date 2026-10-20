import type { WireDelta } from "#core/delta";
import { SyncError } from "#core/errors";

export type PullRequest = { cursor: string | null; excludeNodeId: string; limit: number };
export type PullResult<D extends WireDelta = WireDelta> = {
  deltas: D[];
  cursor: string | null;
  hasMore: boolean;
};

/** The server answered in a way the protocol forbids, e.g. `hasMore` without advancing the cursor. */
export class ServerProtocolError extends SyncError {
  readonly code = "server-protocol" as const;

  constructor(message: string) {
    super(message);
    this.name = "ServerProtocolError";
  }
}

/** Adapters throw this for a cursor they didn't issue. */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export type ServerDatabaseAdapter = {
  push(userId: string, deltas: WireDelta[]): Promise<void>;
  pull(userId: string, request: PullRequest): Promise<PullResult>;
  deleteUser(userId: string): Promise<void>;
};
