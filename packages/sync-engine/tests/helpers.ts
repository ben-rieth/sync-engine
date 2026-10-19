import { expect } from "vitest";
import { createSyncClient, type SyncClient, type SyncClientOptions } from "#core/client/client";
import type { Delta } from "#core/delta";
import type { SyncError } from "#core/errors";
import { HLCTimestamp } from "#core/hlc/timestamp";
import type { Result } from "#core/result";

/** A `set` delta on items/obj-1/title whose timestamp is `physical` on `node`. */
export const delta = (physical: number, node = "node-a", value: unknown = physical): Delta => ({
  kind: "set",
  timestamp: new HLCTimestamp(physical, 0, node).toString(),
  table: "items",
  objectId: "obj-1",
  column: "title",
  value,
});

export const timestamps = (deltas: Delta[]): string[] => deltas.map((d) => d.timestamp);

/** Returns `list[index]`, throwing instead of returning undefined when it is out of range. */
export const elementAt = <T>(list: readonly T[], index: number): T => {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`No element at index ${index} (length ${list.length})`);
  }
  return value;
};

export const ok = async <T>(call: Promise<Result<T>>): Promise<T> => {
  const { result, error } = await call;
  if (error) {
    throw error;
  }
  return result;
};

export const failed = async <E extends SyncError, C extends E["code"]>(
  call: Promise<Result<unknown, E>>,
  code: C,
): Promise<E & { code: C }> => {
  const { error } = await call;
  if (error && hasCode(error, code)) {
    return error;
  }
  throw new Error(`Expected a ${code} error, got ${error ? error.code : "success"}`);
};

const hasCode = <E extends SyncError, C extends E["code"]>(
  error: E,
  code: C,
): error is E & { code: C } => error.code === code;

export const failedBecause = async <E extends SyncError, C extends E["code"]>(
  call: Promise<Result<unknown, E>>,
  code: C,
  message: string,
): Promise<E & { code: C }> => {
  const error = await failed(call, code);
  expect(error.cause).toMatchObject({ message });
  return error;
};

type ValueOf<R> = Extract<R, { error: null }> extends { result: infer T } ? T : never;
type Unwrap<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<ValueOf<R>>
  : never;

export type UnwrappedClient = {
  [K in Exclude<keyof SyncClient, "nodeId">]: Unwrap<SyncClient[K]>;
} & { nodeId: string; raw: SyncClient };

/** For arrange steps: a failing setup call fails the test. Use `raw` to assert on a Result. */
export const unwrapped = (client: SyncClient): UnwrappedClient => ({
  nodeId: client.nodeId,
  raw: client,
  insert: (...args) => ok(client.insert(...args)),
  update: (...args) => ok(client.update(...args)),
  delete: (...args) => ok(client.delete(...args)),
  syncNow: () => ok(client.syncNow()),
});

export const openClient = async (options: SyncClientOptions): Promise<UnwrappedClient> => {
  const client = await ok(createSyncClient(options));
  return unwrapped(client);
};
