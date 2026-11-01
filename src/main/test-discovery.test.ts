import { execFile } from "node:child_process";
import { globSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const main = path.join(root, "src/main");
let discovered: { file: string; projectName?: string }[];

beforeAll(async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(root, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--json"],
    { cwd: root, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  discovered = JSON.parse(stdout);
}, 25_000);

describe("root test discovery", () => {
  it.each([
    ["@vortex/main", ["src/**/*.test.ts", "*.test.ts"]],
    ["@vortex/main (integration)", ["src/**/*.test.integration.ts"]],
  ])("discovers every suite in %s", (projectName, patterns) => {
    const expected = globSync(patterns, { cwd: main }).map((file) => path.join(main, file));
    expect(expected.length).toBeGreaterThan(0);
    expect(
      discovered
        .filter((file) => file.projectName === projectName)
        .map((file) => file.file)
        .toSorted(),
    ).toEqual(expected.toSorted());
  });

  it("includes infrastructure checks and leaves E2E to its separate runner", () => {
    expect(discovered).toContainEqual({
      file: path.join(root, "scripts/check-package-build-setup.test.ts"),
      projectName: "scripts",
    });
    expect(discovered.some((file) => file.file.startsWith(path.join(root, "packages/e2e/")))).toBe(
      false,
    );
  });
});
