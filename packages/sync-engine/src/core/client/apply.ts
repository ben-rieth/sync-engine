import type { Delta } from "../delta";
import { HLCTimestamp } from "../hlc/timestamp";
import { planMerge } from "../merge";
import type { StorageTx } from "../storage";

/**
 * Merges remote deltas into `tx`: applies winning values to rows, records new deltas in history,
 * and advances the clock via `receive`. `receive` runs before any write, so a drift error leaves
 * `tx` untouched.
 */
export const applyRemoteDeltas = async (
  tx: StorageTx,
  deltas: Delta[],
  receive: (timestamp: string) => void,
): Promise<void> => {
  if (deltas.length === 0) {
    return;
  }

  for (const delta of deltas) {
    // Merge orders and dedups by raw string, so reject malformed timestamps
    HLCTimestamp.parse(delta.timestamp);
  }
  const cells = deltas.filter((delta) => delta.kind === "set");

  const [knownTimestamps, latest, deleted] = await Promise.all([
    tx.history.has(deltas.map((delta) => delta.timestamp)),
    tx.latest(cells),
    tx.deleted(deltas),
  ]);

  const plan = planMerge({ incoming: deltas, latest, deleted, knownTimestamps });

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
