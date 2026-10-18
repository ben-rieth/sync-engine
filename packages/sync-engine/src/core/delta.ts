type DeltaBase = {
  // HLC string, unique per delta (one tick() each)
  timestamp: string;
  table: string;
  objectId: string;
};

export type SetDelta = DeltaBase & { kind: "set"; column: string; value: unknown };
export type DeleteDelta = DeltaBase & { kind: "delete" };
export type Delta = SetDelta | DeleteDelta;

export type DeltaKey = string & { readonly __brand: "DeltaKey" };

const isDeltaKey = (key: string): key is DeltaKey => key.startsWith("[");

export type CellRef = { table: string; objectId: string; column: string };

export const deltaKey = (cell: CellRef): DeltaKey => {
  const key = JSON.stringify([cell.table, cell.objectId, cell.column]);
  if (!isDeltaKey(key)) {
    throw new Error("unreachable: JSON array encoding");
  }
  return key;
};
