import { defineConfig } from "eslint/config";

import { baseConfig } from "../../config/eslint.mjs";

export default defineConfig([...baseConfig(import.meta.dirname)]);
