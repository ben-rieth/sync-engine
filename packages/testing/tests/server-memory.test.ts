import { serverMemoryDatabase } from "@sync-engine/core/adapters";
import { runServerDatabaseConformance } from "../src/index";

runServerDatabaseConformance("memory", {
  create: () => serverMemoryDatabase(),
  invalidCursors: ["-1", "1.5", "abc", "", "1e3"],
});
