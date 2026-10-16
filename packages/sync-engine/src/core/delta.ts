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

export const getDeltaKey = (delta: SetDelta): DeltaKey => {
  const key = JSON.stringify([delta.table, delta.objectId, delta.column]);
  if (!isDeltaKey(key)) throw new Error("unreachable: JSON array encoding");
  return key;
};
