import type { Delta } from "#core/delta";
import { assertMaxDriftMs, assertWithinDrift, DEFAULT_MAX_DRIFT_MS } from "#core/hlc/clock";
import { HLCTimestamp } from "#core/hlc/timestamp";
import type { PullResult, ServerDatabaseAdapter } from "#core/server/server";
import { cloneJson } from "#utils/json";

type LogEntry = {
  // Global across users and never reused, like a Postgres bigserial
  sequence: number;
  delta: Delta;
  // Parsed on push so pulls don't re-parse timestamps
  nodeId: string;
};

type UserLog = {
  // Append-only, so sequences ascend
  entries: LogEntry[];
  storedTimestamps: Set<string>;
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
      log = { entries: [], storedTimestamps: new Set() };
      state.set(userId, log);
    }

    return log;
  };

  return {
    push: async (userId, deltas) => {
      // Validate everything before writing so one bad delta rejects the whole push
      const wallTime = now();
      const parsed: Omit<LogEntry, "sequence">[] = [];
      for (const delta of deltas) {
        const timestamp = HLCTimestamp.parse(delta.timestamp);
        // A far-ahead client clock would otherwise poison the log
        assertWithinDrift(timestamp, wallTime, maxDriftMs);

        parsed.push({ delta: cloneJson(delta), nodeId: timestamp.nodeId });
      }

      const log = userLog(userId);
      for (const { delta, nodeId } of parsed) {
        // Timestamps include the node id, so a repeat is a retried push
        if (log.storedTimestamps.has(delta.timestamp)) {
          continue;
        }

        lastSequence++;
        log.entries.push({ sequence: lastSequence, delta, nodeId });
        log.storedTimestamps.add(delta.timestamp);
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
      // The cursor also advances past the caller's own deltas, including trailing ones, so pages
      // of only own deltas still progress and `hasMore` means there is something to return.
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
