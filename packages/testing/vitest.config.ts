import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    slowTestThreshold: 2000,
  },
});
export default config;
