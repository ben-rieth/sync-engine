import type { Delta } from "#core/delta";
import { SyncError } from "#core/errors";

export type PullRequest = { cursor: string | null; excludeNodeId: string; limit: number };
export type PullResult = { deltas: Delta[]; cursor: string | null; hasMore: boolean };

/** The server answered in a way the protocol forbids, e.g. `hasMore` without advancing the cursor. */
export class ServerProtocolError extends SyncError {
  readonly code = "server-protocol" as const;

  constructor(message: string) {
    super(message);
    this.name = "ServerProtocolError";
  }
}

export type ServerDatabaseAdapter = {
  push(userId: string, deltas: Delta[]): Promise<void>;
  pull(userId: string, request: PullRequest): Promise<PullResult>;
  deleteUser(userId: string): Promise<void>;
};
