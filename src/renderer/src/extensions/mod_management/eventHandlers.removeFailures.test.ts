import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { makeMod } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import * as fs from "../../util/fs";
import { onRemoveMods } from "./eventHandlers";
import type InstallManager from "./InstallManager";

afterEach(() => vi.restoreAllMocks());

test("mixed removal failures retain failed mods and persist completed removals for retry", async ({
  makeApi,
}) => {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "nyastra-removal-"));
  const ids = ["blocked", "removed-a", "removed-b"];
  const mods = Object.fromEntries(ids.map((id) => [id, makeMod({ id, installationPath: id })]));
  const h = makeApi({ mods: { skyrimse: mods }, installPath: { skyrimse: root } });
  const markRecentRemoval = vi.fn();
  const manager = { markRecentRemoval } as unknown as InstallManager;
  vi.spyOn(h.api, "emitAndAwait").mockImplementation(async (event, ...args) => {
    await h.emitAndAwait(event, ...args);
    return [];
  });
  let finished = 0;
  const results: Array<Error | null> = [];
  h.api.events.on("did-remove-mods", () => {
    finished++;
  });
  for (const id of ids) {
    nodeFs.mkdirSync(path.join(root, id));
    nodeFs.writeFileSync(path.join(root, id, "mod.ini"), id);
  }
  const remove = fs.removeAsync;
  const failure = Object.assign(new Error("remove denied"), { code: "EACCES" });
  const fault = vi
    .spyOn(fs, "removeAsync")
    .mockImplementation((directory, ...args) =>
      directory === path.join(root, "blocked")
        ? PromiseBB.reject(failure)
        : remove(directory, ...args),
    );
  try {
    onRemoveMods(h.api, [], manager, "skyrimse", ids, (err) => {
      results.push(err);
    });
    await vi.waitFor(() => expect(finished).toBe(1), { timeout: 1000 });

    expect(Object.keys(h.getState().persistent.mods.skyrimse)).toEqual(["blocked"]);
    expect(results).toEqual([failure]);
    expect(nodeFs.readFileSync(path.join(root, "blocked", "mod.ini"), "utf8")).toBe("blocked");
    expect(nodeFs.existsSync(path.join(root, "removed-a"))).toBe(false);
    expect(nodeFs.existsSync(path.join(root, "removed-b"))).toBe(false);
    expect(markRecentRemoval.mock.calls.map(([id]) => id).sort()).toEqual([
      "removed-a",
      "removed-b",
    ]);

    fault.mockRestore();
    onRemoveMods(h.api, [], manager, "skyrimse", ["blocked"], (err) => {
      results.push(err);
    });
    await vi.waitFor(() => expect(finished).toBe(2), { timeout: 1000 });
    expect(h.getState().persistent.mods.skyrimse).toEqual({});
    expect(results).toEqual([failure, null]);
    expect(nodeFs.existsSync(path.join(root, "blocked"))).toBe(false);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("removal waits for started removals before notifying callback failure", async ({
  makeApi,
}) => {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "nyastra-removal-wait-"));
  const h = makeApi({
    mods: {
      skyrimse: Object.fromEntries(
        ["blocked", "pending"].map((id) => [id, makeMod({ id, installationPath: id })]),
      ),
    },
    installPath: { skyrimse: root },
  });
  const manager = { markRecentRemoval: vi.fn() } as unknown as InstallManager;
  for (const id of ["blocked", "pending"]) nodeFs.mkdirSync(path.join(root, id));
  const remove = fs.removeAsync;
  const failure = Object.assign(new Error("remove denied"), { code: "EACCES" });
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const callback = vi.fn();
  vi.spyOn(fs, "removeAsync").mockImplementation((directory, ...args) => {
    if (directory === path.join(root, "blocked")) return PromiseBB.reject(failure);
    if (directory !== path.join(root, "pending")) return remove(directory, ...args);
    started = true;
    return PromiseBB.resolve(gate).then(() => remove(directory, ...args));
  });
  onRemoveMods(h.api, [], manager, "skyrimse", ["blocked", "pending"], callback);
  try {
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callback).not.toHaveBeenCalled();
  } finally {
    release();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1), { timeout: 1000 });
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
  expect(callback).toHaveBeenCalledWith(failure);
  expect(Object.keys(h.getState().persistent.mods.skyrimse)).toEqual(["blocked"]);
});

test("removal without a callback reports failure through the existing error notification", async ({
  makeApi,
}) => {
  const h = makeApi({ mods: { skyrimse: { blocked: makeMod({ id: "blocked" }) } } });
  const manager = { markRecentRemoval: vi.fn() } as unknown as InstallManager;
  const failure = Object.assign(new Error("remove denied"), { code: "EACCES" });
  vi.spyOn(fs, "removeAsync").mockRejectedValue(failure);
  let finished = false;
  vi.spyOn(h.api, "emitAndAwait").mockImplementation(async (event) => {
    if (event === "did-remove-mods") finished = true;
    return [];
  });

  onRemoveMods(h.api, [], manager, "skyrimse", ["blocked"]);
  await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1000 });

  expect(h.errorNotifications).toEqual([
    expect.objectContaining({ title: "Failed to remove mod", message: failure }),
  ]);
  expect(h.getState().persistent.mods.skyrimse.blocked).toBeDefined();
  expect(manager.markRecentRemoval).not.toHaveBeenCalled();
});
