import { ConfigError } from "../errors";

declare const crypto: { randomUUID?: () => string } | undefined;

export const requireRandomUUID = (): (() => string) => {
  const uuid = typeof crypto !== "undefined" ? crypto.randomUUID?.bind(crypto) : undefined;
  if (!uuid) {
    throw new ConfigError(
      "crypto.randomUUID unavailable in this runtime; pass `generateId` and `generateNodeId` to createSyncClient",
    );
  }
  return uuid;
};
