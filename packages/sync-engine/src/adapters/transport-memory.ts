import type { ServerDatabaseAdapter } from "#core/server/server";
import type { Transport } from "#core/server/transport";
import { cloneJson } from "#utils/json";

export type MemoryTransport = Transport & {
  /** While `false`, every call rejects without reaching the server, like a dropped network. */
  online: boolean;
};

/**
 * Connects a client straight to a `ServerDatabaseAdapter` in the same process, for tests and demos.
 *
 * `userId` is fixed when the transport is created, the way a real server reads it from the session.
 * Requests and responses are copied in both directions, so neither side can share objects with the other.
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
