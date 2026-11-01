import * as nodeFs from "node:fs";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { test } from "../test-utils/deploymentTest";
import { UserCanceled } from "./CustomErrors";
import * as fs from "./fs";
import { transferPath } from "./transferPath";

afterEach(() => vi.restoreAllMocks());

test("canceling a staging transfer never deletes its only source copy", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({ files: { "config.ini": "only copy" } });
  const source = path.join(h.stagingDir, "SomeMod");
  const canceled = new UserCanceled();
  vi.spyOn(fs, "linkAsync").mockRejectedValue(canceled);

  const outcome = await transferPath(source, h.gameDir, () => {}).catch((err: unknown) => err);

  expect.soft(outcome).toBe(canceled);
  expect.soft(nodeFs.existsSync(path.join(source, "config.ini"))).toBe(true);
  expect(nodeFs.existsSync(h.inGame("config.ini"))).toBe(false);
});

for (const canceled of [false, true]) {
  test(`a ${canceled ? "canceled" : "failed"} staging transfer drains started writes and preserves its source for retry`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      files: { "failed.ini": "failed data", "pending.ini": "pending data" },
    });
    const source = path.join(h.stagingDir, "SomeMod");
    const failure = canceled
      ? new UserCanceled()
      : Object.assign(new Error("transfer failed"), { code: "EIO" });
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let settled = false;
    const link = fs.linkAsync;
    const fault = vi.spyOn(fs, "linkAsync").mockImplementation((from, to, ...args) => {
      if (from === path.join(source, "failed.ini")) return PromiseBB.reject(failure);
      if (from !== path.join(source, "pending.ini")) return link(from, to, ...args);
      started = true;
      return PromiseBB.resolve(gate).then(() => link(from, to, ...args));
    });
    const outcome = transferPath(source, h.gameDir, () => {}).then(
      () => {
        settled = true;
        return undefined;
      },
      (err: unknown) => {
        settled = true;
        return err;
      },
    );
    try {
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
    } finally {
      release();
      await outcome;
    }
    expect(await outcome).toBe(failure);
    expect(nodeFs.readFileSync(path.join(source, "failed.ini"), "utf8")).toBe("failed data");
    expect(nodeFs.readFileSync(path.join(source, "pending.ini"), "utf8")).toBe("pending data");
    expect(nodeFs.readFileSync(h.inGame("pending.ini"), "utf8")).toBe("pending data");

    fault.mockRestore();
    await transferPath(source, h.gameDir, () => {});
    expect(nodeFs.existsSync(source)).toBe(false);
    expect(nodeFs.readFileSync(h.inGame("failed.ini"), "utf8")).toBe("failed data");
    expect(nodeFs.readFileSync(h.inGame("pending.ini"), "utf8")).toBe("pending data");
  });
}
