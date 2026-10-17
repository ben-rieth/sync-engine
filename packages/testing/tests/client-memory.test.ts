import { clientMemoryStorage } from "@sync-engine/core/adapters";
import { runStorageConformance } from "../src/index";

runStorageConformance("memory", { create: () => clientMemoryStorage() });
