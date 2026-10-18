import type { Delta } from "#core/delta";
import { assertMaxDriftMs, assertWithinDrift, DEFAULT_MAX_DRIFT_MS } from "#core/hlc/clock";
import { HLCTimestamp } from "#core/hlc/timestamp";
import type { PullResult, ServerDatabaseAdapter } from "#core/server/server";
import { cloneJson } from "#utils/json";

type LogEntry = {
  // shared across all users and never reused, like a Postgres bigserial
  sequence: number;
  delta: Delta;
  // parsed once on push so pulls can filter by node without re-parsing
  nodeId: string;
};

type UserLog = {
  // append-only, in arrival order, so sequences are increasing
  entries: LogEntry[];
  // timestamps already stored, for idempotent pushes
  timestamps: Set<string>;
};

type ServerMemoryState = Map<string, UserLog>;

const parseCursor = (cursor: string | null): number => {
  if (cursor === null) {
    return 0;
  }

  const sequence = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(sequence)) {
    throw new RangeError(`Invalid cursor: ${cursor}`);
  }

  return sequence;
};

const assertLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`Invalid pull limit: ${limit}`);
  }
};

export type ServerMemoryDatabaseOptions = {
  now?: () => number;
  maxDriftMs?: number;
};

export const serverMemoryDatabase = ({
  now = Date.now,
  maxDriftMs = DEFAULT_MAX_DRIFT_MS,
}: ServerMemoryDatabaseOptions = {}): ServerDatabaseAdapter & { state: ServerMemoryState } => {
  assertMaxDriftMs(maxDriftMs, "server");

  const state: ServerMemoryState = new Map();
  let lastSequence = 0;

  const userLog = (userId: string) => {
    let log = state.get(userId);
    if (!log) {
      log = { entries: [], timestamps: new Set() };
      state.set(userId, log);
    }

    return log;
  };

  return {
    push: async (userId, deltas) => {
      // Validate the whole batch before writing anything, so one bad delta rejects the whole push.
      const wallTime = now();
      const parsed: Omit<LogEntry, "sequence">[] = [];
      for (const delta of deltas) {
        const timestamp = HLCTimestamp.parse(delta.timestamp);
        // A client clock far ahead would otherwise poison the log, so reject the batch.
        assertWithinDrift(timestamp, wallTime, maxDriftMs);

        parsed.push({ delta: cloneJson(delta), nodeId: timestamp.nodeId });
      }

      const log = userLog(userId);
      for (const { delta, nodeId } of parsed) {
        // Timestamps include the node id, so they are unique per user. A repeat is a retried push.
        if (log.timestamps.has(delta.timestamp)) {
          continue;
        }

        lastSequence++;
        log.entries.push({ sequence: lastSequence, delta, nodeId });
        log.timestamps.add(delta.timestamp);
      }
    },

    pull: async (userId, request): Promise<PullResult> => {
      assertLimit(request.limit);

      const after = parseCursor(request.cursor);
      const entries = state.get(userId)?.entries ?? [];

      let position = entries.findIndex((entry) => entry.sequence > after);
      if (position === -1) {
        position = entries.length;
      }
      let cursor = after;

      const deltas: Delta[] = [];
      // Scan past the caller's own deltas too, so the cursor advances even on pages made up only of them.
      // Then keep skipping trailing own deltas, so `hasMore` is only true when there is something to return.
      for (; position < entries.length; position++) {
        const entry = entries[position];
        if (!entry) {
          break;
        }

        if (entry.nodeId !== request.excludeNodeId) {
          if (deltas.length === request.limit) {
            break;
          }
          deltas.push(cloneJson(entry.delta));
        }
        cursor = entry.sequence;
      }

      return { deltas, cursor: String(cursor), hasMore: position < entries.length };
    },

    deleteUser: async (userId) => {
      state.delete(userId);
    },

    state,
  };
};
