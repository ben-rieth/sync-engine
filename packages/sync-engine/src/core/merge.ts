import { deltaKey, type Delta, type DeltaKey } from "./delta";
import { compareTimestamps } from "./hlc/timestamp";
import { objectKey, type ObjectKey } from "./object";

type RowWrite =
  | { kind: "patch"; table: string; objectId: string; patch: Record<string, unknown> }
  | { kind: "delete"; table: string; objectId: string };

type MergeInput = {
  // Any order; may include already-known deltas
  incoming: Delta[];
  // Newest local timestamp per cell; with `deleted`, drops re-delivered deltas
  latest: Map<DeltaKey, string>;
  // Deletes are final: later deltas for these are never applied
  deleted: Set<ObjectKey>;
};

type MergePlan = {
  writes: RowWrite[];
  // Only deltas that took effect: losing sets and repeat deletes change nothing in history
  historyAdds: Delta[];
  maxTimestamp: string | null;
};

export const planMerge = (input: MergeInput): MergePlan => {
  const sorted = input.incoming.toSorted((a, b) => compareTimestamps(a.timestamp, b.timestamp));

  const writes = new Map<ObjectKey, RowWrite>();
  const historyAdds: Delta[] = [];

  const cellLatest = new Map(input.latest);

  const deletedObjects = new Set(input.deleted);

  let maxTimestamp: string | null = null;

  for (const delta of sorted) {
    maxTimestamp = delta.timestamp;

    const object = objectKey(delta);

    if (deletedObjects.has(object)) {
      continue;
    }

    if (delta.kind === "delete") {
      deletedObjects.add(object);
      historyAdds.push(delta);
      writes.set(object, { kind: "delete", table: delta.table, objectId: delta.objectId });
      continue;
    }

    const cell = deltaKey(delta);
    const current = cellLatest.get(cell);

    if (current !== undefined && current >= delta.timestamp) {
      continue;
    }

    cellLatest.set(cell, delta.timestamp);
    historyAdds.push(delta);

    let write = writes.get(object);
    if (!write) {
      const patch: Record<string, unknown> = Object.create(null);
      write = { kind: "patch", table: delta.table, objectId: delta.objectId, patch };
      writes.set(object, write);
    }

    if (write.kind === "patch") {
      write.patch[delta.column] = delta.value;
    }
  }

  return {
    writes: [...writes.values()],
    historyAdds,
    maxTimestamp,
  };
};
