import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../config/vitest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  }),
);
