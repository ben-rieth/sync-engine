import { defineConfig, type UserConfig } from "tsdown";
import { baseConfig } from "../../tsdown.base.ts";

const config: UserConfig = defineConfig({
  ...baseConfig,
  entry: {
    index: "src/index.ts",
  },
  platform: "neutral",
});
export default config;
