import path from "node:path";

import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../../config/vitest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "@nexusmods/vortex-api": path.resolve(import.meta.dirname, "src/__mocks__/vortex-api.ts"),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      // divine.exe invocations can be slow on cold caches.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);
