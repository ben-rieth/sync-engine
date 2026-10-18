type DeltaBase = {
  // HLC string from HybridLogicalClock; unique per delta (one tick() each)
  timestamp: string;
  table: string;
  objectId: string;
};

export type SetDelta = DeltaBase & { kind: "set"; column: string; value: unknown };
export type DeleteDelta = DeltaBase & { kind: "delete" };
export type Delta = SetDelta | DeleteDelta;

export type DeltaKey = string & { readonly __brand: "DeltaKey" }; // JSON of [table, objectId, column]

const isDeltaKey = (key: string): key is DeltaKey => key.startsWith("[");

/** Identifies a single cell: one column of one object in one table. A `SetDelta` is a valid `CellRef`. */
export type CellRef = { table: string; objectId: string; column: string };

export const deltaKey = (cell: CellRef): DeltaKey => {
  const key = JSON.stringify([cell.table, cell.objectId, cell.column]);
  if (!isDeltaKey(key)) {
    throw new Error("unreachable: JSON array encoding");
  }
  return key;
};
