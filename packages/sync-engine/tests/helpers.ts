import type { Delta } from "#core/delta";
import { HLCTimestamp } from "#core/hlc/timestamp";

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
