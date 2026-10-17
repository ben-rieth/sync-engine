import { clientMemoryStorage } from "#adapters/client-memory";
import { runStorageConformance } from "#testing/storage-conformance";

runStorageConformance("memory", { create: () => clientMemoryStorage() });
