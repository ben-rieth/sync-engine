import type { Delta } from "#core/delta";

export type PullRequest = { cursor: string | null; excludeNodeId: string; limit: number };
export type PullResult = { deltas: Delta[]; cursor: string | null; hasMore: boolean };

export type ServerDatabaseAdapter = {
  push(userId: string, deltas: Delta[]): Promise<void>;
  pull(userId: string, request: PullRequest): Promise<PullResult>;
  deleteUser(userId: string): Promise<void>;
};
