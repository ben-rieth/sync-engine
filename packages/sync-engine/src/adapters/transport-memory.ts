import type { ServerDatabaseAdapter } from "#core/server/server";
import type { Transport } from "#core/server/transport";
import { cloneJson } from "#utils/json";

export type MemoryTransport = Transport & {
  /** While `false`, every call rejects without reaching the server, like a dropped network. */
  online: boolean;
};

/**
 * Connects a client to an in-process `ServerDatabaseAdapter`, for tests and demos. `userId` is
 * fixed, as a real server reads it from the session. Requests and responses are deep-copied.
 */
export const memoryTransport = (server: ServerDatabaseAdapter, userId: string): MemoryTransport => {
  const transport: MemoryTransport = {
    online: true,

    pull: async ({ cursor, nodeId, limit }) => {
      assertOnline(transport);
      const result = await server.pull(userId, { cursor, excludeNodeId: nodeId, limit });
      return cloneJson(result);
    },

    push: async ({ deltas }) => {
      assertOnline(transport);
      await server.push(userId, cloneJson(deltas));
    },
  };

  return transport;
};

const assertOnline = (transport: MemoryTransport) => {
  if (!transport.online) {
    throw new Error("memoryTransport is offline");
  }
};
