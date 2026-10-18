export type ObjectKey = string & { readonly __brand: "ObjectKey" };

export type ObjectRef = { table: string; objectId: string };

const isObjectKey = (key: string): key is ObjectKey => key.startsWith("[");

export const objectKey = ({ table, objectId }: ObjectRef): ObjectKey => {
  const key = JSON.stringify([table, objectId]);
  if (!isObjectKey(key)) {
    throw new Error("unreachable: JSON array encoding");
  }
  return key;
};
