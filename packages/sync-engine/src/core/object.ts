export type ObjectKey = string & { readonly __brand: "ObjectKey" }; // JSON of [table, objectId]

const isObjectKey = (key: string): key is ObjectKey => key.startsWith("[");

export const getObjectKey = ({
  table,
  objectId,
}: {
  table: string;
  objectId: string;
}): ObjectKey => {
  const key = JSON.stringify([table, objectId]);
  if (!isObjectKey(key)) throw new Error("unreachable: JSON array encoding");
  return key;
};
