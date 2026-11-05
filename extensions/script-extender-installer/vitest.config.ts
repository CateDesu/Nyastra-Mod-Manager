import path from "node:path";

import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../config/vitest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@nexusmods/vortex-api": path.resolve(
          import.meta.dirname,
          "../../packages/extension-test-mocks/src/index.ts",
        ),
      },
    },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  }),
);
