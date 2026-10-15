import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../config/vitest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@vortex/main",
      environment: "node",
      include: ["src/**/*.test.ts", "*.test.ts"],
      setupFiles: "./src/test-setup.ts",
    },
  }),
);
