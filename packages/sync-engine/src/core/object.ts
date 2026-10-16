export type ObjectKey = string & { readonly __brand: "ObjectKey" }; // JSON of [table, objectId]

/** Identifies a single object in one table. A `Delta` is a valid `ObjectRef`. */
export type ObjectRef = { table: string; objectId: string };

const isObjectKey = (key: string): key is ObjectKey => key.startsWith("[");

export const objectKey = ({ table, objectId }: ObjectRef): ObjectKey => {
  const key = JSON.stringify([table, objectId]);
  if (!isObjectKey(key)) throw new Error("unreachable: JSON array encoding");
  return key;
};
