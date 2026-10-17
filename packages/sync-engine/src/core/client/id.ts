declare const crypto: { randomUUID?: () => string } | undefined;

export const defaultGenerateId = (): string => {
  const uuid = typeof crypto !== "undefined" ? crypto.randomUUID : undefined;
  if (!uuid) {
    throw new Error(
      "crypto.randomUUID unavailable in this runtime; pass `generateId` and `generateNodeId` to createSyncClient",
    );
  }
  return uuid.call(crypto);
};
