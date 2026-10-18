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
