import { stat } from "node:fs/promises";

import { vi } from "vitest";

export const fs = { statAsync: stat };
export const selectors = {
  activeGameId: () => "test-game",
  installPath: (state: { stagingPath: string }) => state.stagingPath,
};
export const util = {
  opn: vi.fn<(target: string) => Promise<void>>(async () => undefined),
  getSafe: (value: unknown, keys: string[], fallback: unknown) => {
    let result = value;
    for (const key of keys) result = result?.[key];
    return result === undefined ? fallback : result;
  },
};
