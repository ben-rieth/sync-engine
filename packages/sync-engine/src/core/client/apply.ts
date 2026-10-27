import { deltaKey, type Delta } from "../delta";
import { planMerge } from "../merge";
import { objectKey } from "../object";
import type { StorageTx } from "../storage";

const uniqueBy = <T>(items: T[], key: (item: T) => string): T[] => [
  ...new Map(items.map((item) => [key(item), item])).values(),
];

/**
 * Merges remote deltas into `tx`: applies winning values to rows, records the deltas that took
 * effect in history, and advances the clock via `receive`. `receive` runs before any write, so a
 * drift error leaves `tx` untouched.
 */
export const applyRemoteDeltas = async (
  tx: StorageTx,
  deltas: Delta[],
  receive: (timestamp: string) => void,
): Promise<void> => {
  if (deltas.length === 0) {
    return;
  }

  // A page often holds many deltas per row and cell, so look each up once
  const cells = uniqueBy(
    deltas.filter((delta) => delta.kind === "set"),
    deltaKey,
  );
  const objects = uniqueBy(deltas, objectKey);

  const [latest, deleted] = await Promise.all([tx.latest(cells), tx.deleted(objects)]);

  const plan = planMerge({ incoming: deltas, latest, deleted });

  if (plan.maxTimestamp !== null) {
    receive(plan.maxTimestamp);
  }

  const operations = [];
  for (const write of plan.writes) {
    if (write.kind === "delete") {
      operations.push(tx.rows.delete(write.table, write.objectId));
    } else {
      operations.push(tx.rows.upsert(write.table, write.objectId, write.patch));
    }
  }

  await Promise.all(operations);

  await tx.history.add(plan.historyAdds);
};
