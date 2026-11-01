import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";

import { vi } from "vitest";

export const fs = {
  createReadStream,
  removeAsync: vi.fn<(target: string) => Promise<void>>((target) =>
    rm(target, { recursive: true, force: true }),
  ),
};
export const util = { NotSupportedError: class extends Error {} };
