import { describe, expect, it } from "vitest";
import { serverMemoryDatabase } from "#adapters/server-memory";
import { memoryTransport } from "#adapters/transport-memory";
import type { Delta } from "#core/delta";
import type { PullRequest, ServerDatabaseAdapter } from "#core/server/server";
import { delta, timestamps } from "../helpers";

// Records calls and returns shared objects, so tests can see whether the transport copies
const spyServer = () => {
  const pushes: { userId: string; deltas: Delta[] }[] = [];
  const pulls: { userId: string; request: PullRequest }[] = [];
  const stored: Delta[] = [];

  const server: ServerDatabaseAdapter = {
    push: async (userId, deltas) => {
      pushes.push({ userId, deltas });
      stored.push(...deltas);
    },
    pull: async (userId, request) => {
      pulls.push({ userId, request });
      return { deltas: stored, cursor: "1", hasMore: false };
    },
    deleteUser: async () => {},
  };

  return { server, pushes, pulls, stored };
};

describe("memoryTransport", () => {
  it("pushes deltas for its user and pulls them from another node", async () => {
    const server = serverMemoryDatabase();
    const a = memoryTransport(server, "user-1");
    const b = memoryTransport(server, "user-1");

    await a.push({ nodeId: "node-a", deltas: [delta(1, "node-a")] });
    const page = await b.pull({ cursor: null, nodeId: "node-b", limit: 10 });

    expect(timestamps(page.deltas)).toEqual(timestamps([delta(1, "node-a")]));
    expect(page).toMatchObject({ cursor: "1", hasMore: false });
  });

  it("passes the user id and maps nodeId to excludeNodeId", async () => {
    const { server, pushes, pulls } = spyServer();
    const transport = memoryTransport(server, "user-1");

    await transport.push({ nodeId: "node-a", deltas: [delta(1)] });
    await transport.pull({ cursor: "7", nodeId: "node-a", limit: 3 });

    expect(pushes.map((p) => p.userId)).toEqual(["user-1"]);
    expect(pulls).toEqual([
      { userId: "user-1", request: { cursor: "7", excludeNodeId: "node-a", limit: 3 } },
    ]);
  });

  it("does not pull the caller's own deltas", async () => {
    const server = serverMemoryDatabase();
    const transport = memoryTransport(server, "user-1");

    await transport.push({ nodeId: "node-a", deltas: [delta(1, "node-a")] });
    const page = await transport.pull({ cursor: null, nodeId: "node-a", limit: 10 });

    expect(page.deltas).toEqual([]);
  });

  it("keeps users separate", async () => {
    const server = serverMemoryDatabase();

    await memoryTransport(server, "user-1").push({ nodeId: "node-a", deltas: [delta(1)] });
    const page = await memoryTransport(server, "user-2").pull({
      cursor: null,
      nodeId: "node-b",
      limit: 10,
    });

    expect(page.deltas).toEqual([]);
  });

  it("copies pushed deltas, so later changes by the caller do not reach the server", async () => {
    const { server, pushes } = spyServer();
    const transport = memoryTransport(server, "user-1");
    const deltas = [delta(1, "node-a", { nested: "before" })];

    await transport.push({ nodeId: "node-a", deltas });
    const [sent] = deltas;
    if (sent?.kind === "set") {
      sent.value = { nested: "after" };
    }

    expect(pushes[0]?.deltas).not.toBe(deltas);
    expect(pushes[0]?.deltas[0]).toMatchObject({ value: { nested: "before" } });
  });

  it("copies pulled results, so changes by the caller do not reach the server", async () => {
    const { server, stored } = spyServer();
    stored.push(delta(1, "node-b", { nested: "before" }));
    const transport = memoryTransport(server, "user-1");

    const page = await transport.pull({ cursor: null, nodeId: "node-a", limit: 10 });
    const [received] = page.deltas;
    if (received?.kind === "set") {
      received.value = { nested: "after" };
    }

    expect(page.deltas).not.toBe(stored);
    expect(stored[0]).toMatchObject({ value: { nested: "before" } });
  });

  it("rejects every call while offline without reaching the server", async () => {
    const { server, pushes, pulls } = spyServer();
    const transport = memoryTransport(server, "user-1");

    transport.online = false;

    await expect(transport.push({ nodeId: "node-a", deltas: [delta(1)] })).rejects.toThrow(
      "memoryTransport is offline",
    );
    await expect(transport.pull({ cursor: null, nodeId: "node-a", limit: 10 })).rejects.toThrow(
      "memoryTransport is offline",
    );
    expect(pushes).toEqual([]);
    expect(pulls).toEqual([]);
  });

  it("works again after coming back online", async () => {
    const server = serverMemoryDatabase();
    const transport = memoryTransport(server, "user-1");

    transport.online = false;
    await expect(transport.push({ nodeId: "node-a", deltas: [delta(1)] })).rejects.toThrow(
      "memoryTransport is offline",
    );
    transport.online = true;
    await transport.push({ nodeId: "node-a", deltas: [delta(1)] });
    const page = await transport.pull({ cursor: null, nodeId: "node-b", limit: 10 });

    expect(page.deltas).toHaveLength(1);
  });

  it("passes server errors through", async () => {
    const transport = memoryTransport(serverMemoryDatabase(), "user-1");

    await expect(transport.pull({ cursor: "abc", nodeId: "node-a", limit: 10 })).rejects.toThrow(
      "Invalid cursor",
    );
  });
});
