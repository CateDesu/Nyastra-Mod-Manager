import { defineConfig } from "eslint/config";
import globals from "globals";

import { baseConfig } from "../../config/eslint.mjs";

export default defineConfig([
  ...baseConfig(import.meta.dirname),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]);
