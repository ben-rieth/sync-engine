import type { WireDelta } from "#core/delta";
import { HLCTimestamp } from "#core/hlc/timestamp";
import {
  InvalidCursorError,
  type PullResult,
  type ServerDatabaseAdapter,
} from "#core/server/server";
import { cloneJson, quote } from "#utils/json";

type LogEntry = {
  // Global across users and never reused, like a Postgres bigserial
  sequence: number;
  delta: WireDelta;
  // Parsed on push so pulls don't re-parse timestamps
  nodeId: string;
};

type UserLog = {
  // Append-only, so sequences ascend
  entries: LogEntry[];
  storedTimestamps: Set<string>;
  nodeOwners: Map<string, string>;
};

type ServerMemoryState = Map<string, UserLog>;

const parseCursor = (cursor: string | null): number => {
  if (cursor === null) {
    return 0;
  }

  const sequence = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(sequence)) {
    throw new InvalidCursorError(`Invalid cursor: ${quote(cursor)}`);
  }

  return sequence;
};

const assertLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`Invalid pull limit: ${limit}`);
  }
};

export const serverMemoryDatabase = (): ServerDatabaseAdapter & { state: ServerMemoryState } => {
  const state: ServerMemoryState = new Map();
  let lastSequence = 0;

  const userLog = (userId: string) => {
    let log = state.get(userId);
    if (!log) {
      log = { entries: [], storedTimestamps: new Set(), nodeOwners: new Map() };
      state.set(userId, log);
    }

    return log;
  };

  return {
    push: async (userId, deltas) => {
      // Parse everything before writing so one bad delta rejects the whole push
      const parsed = deltas.map((delta) => ({
        delta: cloneJson(delta),
        nodeId: HLCTimestamp.parse(delta.timestamp).nodeId,
      }));

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

      const deltas: WireDelta[] = [];
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

    // No await inside, so check-and-set is atomic
    claimNode: async (userId, nodeId, deviceId) => {
      const { nodeOwners } = userLog(userId);
      const owner = nodeOwners.get(nodeId);
      if (owner === undefined) {
        nodeOwners.set(nodeId, deviceId);
        return true;
      }

      return owner === deviceId;
    },

    state,
  };
};
