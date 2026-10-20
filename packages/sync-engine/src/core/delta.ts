import { fail, ok, type Parsed } from "#utils/parsed";

type DeltaBase = {
  // HLC string, unique per delta (one tick() each)
  timestamp: string;
  table: string;
  objectId: string;
};

export type SetDelta = DeltaBase & { kind: "set"; column: string; value: unknown };
export type DeleteDelta = DeltaBase & { kind: "delete" };
export type Delta = SetDelta | DeleteDelta;

/** Only `timestamp` is readable on the server; a codec owns the rest. */
export type WireDelta = { timestamp: string; [field: string]: unknown };

/** Drops fields `Delta` doesn't know. */
export const parseDelta = (delta: WireDelta): Parsed<Delta> => {
  const { kind, timestamp, table, objectId } = delta;
  if (typeof table !== "string" || typeof objectId !== "string") {
    return fail(`Delta ${timestamp} needs a string table and objectId`);
  }
  if (kind === "delete") {
    return ok({ kind, timestamp, table, objectId });
  }
  if (kind !== "set") {
    return fail(`Delta ${timestamp} has an unknown kind`);
  }

  const { column } = delta;
  if (typeof column !== "string" || !Object.hasOwn(delta, "value")) {
    return fail(`Set delta ${timestamp} needs a string column and a value`);
  }
  return ok({ kind, timestamp, table, objectId, column, value: delta.value });
};

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
