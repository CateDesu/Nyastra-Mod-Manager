import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { makeMod, makeProfile } from "../../../test-utils/builders";
import { test, type IDeploymentHarness } from "../../../test-utils/deploymentTest";
import * as native from "../../../util/fs";
import * as atomic from "../../../util/fsAtomic";
import { confirmExternalChanges, setExternalChanges } from "../actions/session";
import type { IFileEntry } from "../types/IFileEntry";
import * as activation from "./activationStore";
import { dealWithExternalChanges } from "./externalChanges";

vi.mock("node:fs", async (original) => {
  const nativeFs = await original<typeof fs>();
  return {
    ...nativeFs,
    mkdtempSync: (...args: Parameters<typeof nativeFs.mkdtempSync>) =>
      nativeFs.realpathSync(nativeFs.mkdtempSync(...args)),
  };
});

afterEach(() => vi.restoreAllMocks());

function observeDialog(h: IDeploymentHarness) {
  const received: IFileEntry[][] = [];
  let waiting: ((entries: IFileEntry[]) => void) | undefined;
  const shown = vi.fn<(entries: IFileEntry[]) => void>();
  let previous: unknown;
  const stop = h.api.store.subscribe(() => {
    const action = h.dispatched.at(-1);
    if (
      action === previous ||
      action?.type !== String(setExternalChanges) ||
      !Array.isArray(action.payload) ||
      action.payload.length === 0
    )
      return;
    previous = action;
    const entries = action.payload as IFileEntry[];
    shown(entries);
    if (waiting) {
      waiting(entries);
      waiting = undefined;
    } else received.push(entries);
  });
  return {
    shown,
    stop,
    next: () =>
      received.length > 0
        ? Promise.resolve(received.shift())
        : new Promise<IFileEntry[]>((resolve) => {
            waiting = resolve;
          }),
  };
}

function observeWork(h: IDeploymentHarness) {
  const nativeWork: PromiseLike<unknown>[] = [];
  const publicWork: Promise<{ error: unknown }>[] = [];
  const terminal = vi.fn<(error: unknown) => void>();
  const changed = vi.fn<(...args: unknown[]) => void>();
  h.api.events.on("mod-content-changed", changed);
  const track = <T extends PromiseLike<unknown>>(operation: T): T => {
    nativeWork.push(operation);
    void Promise.resolve(operation).catch(() => undefined);
    return operation;
  };
  const ensure = native.ensureDirAsync;
  const preparations = vi
    .spyOn(native, "ensureDirAsync")
    .mockImplementation((...args) => track(ensure(...args)));
  const copy = atomic.copyFileAtomic;
  const copies = vi
    .spyOn(atomic, "copyFileAtomic")
    .mockImplementation((...args) => track(copy(...args)));
  const unlink = native.unlinkAsync;
  const unlinks = vi
    .spyOn(native, "unlinkAsync")
    .mockImplementation((...args) => track(unlink(...args)));
  const save = activation.saveActivation;
  const saves = vi
    .spyOn(activation, "saveActivation")
    .mockImplementation((...args) => track(save(...args)));
  const begin = (last: Parameters<typeof dealWithExternalChanges>[5]) => {
    const original = dealWithExternalChanges(
      h.api,
      h.method,
      "p",
      h.stagingDir,
      { "": h.gameDir },
      last,
    );
    const outcome = Promise.resolve(original)
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      )
      .then((result) => {
        terminal(result.error);
        return result;
      });
    publicWork.push(outcome);
    return outcome;
  };
  const drain = async () => {
    await Promise.all(publicWork);
    let count = -1;
    while (count !== nativeWork.length) {
      count = nativeWork.length;
      await Promise.allSettled(nativeWork);
    }
  };
  return { track, preparations, copies, unlinks, saves, terminal, changed, begin, drain };
}

async function persist(h: IDeploymentHarness, manifest: Awaited<ReturnType<typeof h.deploy>>) {
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "external-parent-fixture" };
  });
  await activation.saveActivation(
    "skyrimse",
    "",
    h.getState().app.instanceId,
    h.gameDir,
    h.stagingDir,
    manifest,
    h.method.id,
  );
}

for (const vanished of [false, true]) {
  test(`import reports a staging parent lost after preparation, vanished=${vanished}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      files: { "nested/config.ini": "original staging" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
    });
    const source = path.join(h.stagingDir, "SomeMod/nested/config.ini");
    const deployed = h.inGame("nested/config.ini");
    const backup = path.join(h.stagingDir, "SomeMod/nested-held");
    const manifest = await h.deploy();
    await persist(h, manifest);
    fs.unlinkSync(deployed);
    fs.writeFileSync(deployed, "updated by game");
    const dialog = observeDialog(h);
    const work = observeWork(h);
    const ensure = work.preparations.getMockImplementation();
    let moved = false;
    work.preparations.mockImplementation((...args) =>
      work.track(
        ensure(...args).then((result) => {
          if (vanished && !moved && args[0] === path.dirname(source)) {
            moved = true;
            fs.renameSync(path.dirname(source), backup);
          }
          return result;
        }),
      ),
    );
    const copy = work.copies.getMockImplementation();
    let nativeError: unknown;
    work.copies.mockImplementation((...args) =>
      work.track(
        copy(...args).catch((error) => {
          nativeError = error;
          throw error;
        }),
      ),
    );
    const last = { "": manifest };
    try {
      const original = work.begin(last);
      const entries = await dialog.next();
      h.api.store.dispatch(
        confirmExternalChanges(
          entries.map((entry) => ({ ...entry, action: "import" as const })),
          false,
        ),
      );
      const result = await original;
      await work.drain();
      const saved = await activation.loadActivation(
        h.api,
        "skyrimse",
        "",
        h.gameDir,
        h.stagingDir,
        h.method,
      );
      expect(entries).toEqual([
        expect.objectContaining({
          type: "refchange",
          source: "SomeMod",
          filePath: "nested/config.ini",
        }),
      ]);
      expect(work.terminal).toHaveBeenCalledTimes(1);
      expect(work.copies).toHaveBeenCalledTimes(1);
      expect.soft(work.saves).toHaveBeenCalledTimes(vanished ? 0 : 1);
      if (vanished) {
        expect(nativeError).toMatchObject({
          code: "ENOENT",
          syscall: "lstat",
          path: path.dirname(source),
        });
        expect
          .soft(result.error, "a destination preparation loss must reach the public result")
          .toBe(nativeError);
        expect
          .soft(last[""], "an import which was not copied must retain its manifest entry")
          .toEqual(manifest);
        expect.soft(saved, "failed imports must remain tracked on disk").toEqual(manifest);
        expect(fs.readFileSync(deployed, "utf8")).toBe("updated by game");
        expect(fs.readFileSync(path.join(backup, "config.ini"), "utf8")).toBe("original staging");
        expect(work.unlinks).toHaveBeenCalledTimes(0);
        expect.soft(work.changed).toHaveBeenCalledTimes(0);
      } else {
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(source, "utf8")).toBe("updated by game");
        expect(fs.existsSync(deployed)).toBe(false);
        expect(last[""]).toEqual([]);
        expect(saved).toEqual([]);
        expect(work.changed).toHaveBeenCalledTimes(1);
      }
    } finally {
      h.api.store.dispatch(confirmExternalChanges([], true));
      await work.drain();
      dialog.stop();
      h.api.events.removeAllListeners();
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
    }
  });
}
