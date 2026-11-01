import fs from "node:fs";
import path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, expect, vi } from "vitest";

import { makeMod, makeProfile } from "../../../test-utils/builders";
import { test, type IDeploymentHarness } from "../../../test-utils/deploymentTest";
import * as native from "../../../util/fs";
import * as atomic from "../../../util/fsAtomic";
import { confirmExternalChanges, setExternalChanges } from "../actions/session";
import type { IFileEntry } from "../types/IFileEntry";
import * as activation from "./activationStore";
import { dealWithExternalChanges } from "./externalChanges";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => vi.restoreAllMocks());

function observeDialog(h: IDeploymentHarness) {
  const received: IFileEntry[][] = [];
  let waiting: ((entries: IFileEntry[]) => void) | undefined;
  const shown = vi.fn();
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
  const terminal = vi.fn();
  const changed = vi.fn();
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

for (const schedule of [
  "existing-parent",
  "missing-before-dialog",
  "missing-after-dialog",
] as const) {
  test(`public external import restores staging with ${schedule}`, async ({ makeDeployment }) => {
    const h = makeDeployment({
      files: { "nested/config.ini": "original staging" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
    });
    const source = path.join(h.stagingDir, "SomeMod/nested/config.ini");
    const deployed = h.inGame("nested/config.ini");
    const manifest = await h.deploy();
    await persist(h, manifest);
    expect(fs.statSync(source).ino).toBe(fs.statSync(deployed).ino);
    fs.unlinkSync(deployed);
    fs.writeFileSync(deployed, "updated by game");
    expect(fs.statSync(source).ino).not.toBe(fs.statSync(deployed).ino);
    if (schedule === "missing-before-dialog") fs.rmSync(path.dirname(source), { recursive: true });
    const dialog = observeDialog(h);
    const work = observeWork(h);
    const last = { "": manifest };
    try {
      const original = work.begin(last);
      const entries = await dialog.next();
      if (schedule === "missing-after-dialog") fs.rmSync(path.dirname(source), { recursive: true });
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
          type: schedule === "missing-before-dialog" ? "srcdeleted" : "refchange",
          source: "SomeMod",
          filePath: "nested/config.ini",
        }),
      ]);
      expect(result.error).toBeUndefined();
      expect
        .soft(fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null)
        .toBe("updated by game");
      expect.soft(fs.existsSync(deployed)).toBe(false);
      expect.soft(work.unlinks).toHaveBeenCalledTimes(1);
      expect(work.copies).toHaveBeenCalledTimes(1);
      expect(work.terminal).toHaveBeenCalledTimes(1);
      expect(work.changed.mock.calls).toEqual([["skyrimse", "SomeMod"]]);
      expect(dialog.shown).toHaveBeenCalledTimes(1);
      expect(last[""]).toEqual([]);
      expect(saved).toEqual([]);
      expect(work.saves).toHaveBeenCalledTimes(1);
    } finally {
      h.api.store.dispatch(confirmExternalChanges([], true));
      await work.drain();
      dialog.stop();
      h.api.events.removeAllListeners();
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
    }
  });
}

for (const broken of [false, true]) {
  test(`external import settles other copies after destination preparation, broken=${broken}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      files: { "blocked/nested/config.ini": "old blocked", "held/config.ini": "old held" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
    });
    const source = (name: string) => path.join(h.stagingDir, "SomeMod", name, "config.ini");
    const blocked = source("blocked/nested");
    const held = source("held");
    const manifest = await h.deploy();
    await persist(h, manifest);
    for (const name of ["blocked/nested", "held"]) {
      expect(fs.statSync(source(name)).ino).toBe(fs.statSync(h.inGame(`${name}/config.ini`)).ino);
      fs.unlinkSync(h.inGame(`${name}/config.ini`));
      fs.writeFileSync(h.inGame(`${name}/config.ini`), `updated ${name}`);
      expect(fs.statSync(source(name)).ino).not.toBe(
        fs.statSync(h.inGame(`${name}/config.ini`)).ino,
      );
    }
    const dialog = observeDialog(h);
    const work = observeWork(h);
    const entered = deferred();
    const release = deferred();
    const captured = deferred();
    let originalFailure: unknown;
    const prepare = work.preparations.getMockImplementation();
    work.preparations.mockImplementation((...args) =>
      work.track(
        prepare(...args).catch((error: unknown) => {
          if (args[0] === path.dirname(blocked)) originalFailure = error;
          throw error;
        }),
      ),
    );
    const nativeCopy = work.copies.getMockImplementation();
    work.copies.mockImplementation((from, to) => {
      if (to !== held) return nativeCopy(from, to);
      const operation = new PromiseBB<void>((resolve, reject) => {
        void release.promise.then(() => nativeCopy(from, to)).then(resolve, reject);
      });
      work.track(operation);
      entered.resolve();
      return operation;
    });
    const all = Promise.all.bind(Promise) as typeof Promise.all;
    let observing = false;
    vi.spyOn(Promise, "all").mockImplementation((operations) => {
      if (observing && Array.isArray(operations) && operations.length === 2) {
        // Release after an actual per-file outcome or premature public completion.
        observing = false;
        void work.track(
          Promise.resolve(operations[0] as PromiseLike<unknown>).then(
            () => captured.resolve(),
            () => undefined,
          ),
        );
      }
      return all(operations);
    });
    const last = { "": manifest };
    try {
      const first = work.begin(last);
      const entries = await dialog.next();
      if (broken) {
        const parent = path.dirname(blocked);
        fs.rmSync(parent, { recursive: true });
        fs.symlinkSync(path.join(h.stagingDir, "absent-parent"), parent);
      }
      observing = true;
      h.api.store.dispatch(
        confirmExternalChanges(
          [...entries]
            .sort((a, b) => a.filePath.localeCompare(b.filePath))
            .map((entry) => ({ ...entry, action: "import" as const })),
          false,
        ),
      );
      await entered.promise;
      const boundary = await Promise.race([
        captured.promise.then(() => "captured"),
        first.then(() => "public"),
      ]);
      const terminalBeforeRelease = work.terminal.mock.calls.length;
      const savesBeforeRelease = work.saves.mock.calls.length;
      release.resolve();
      const result = await first;
      await work.drain();
      const saved = await activation.loadActivation(
        h.api,
        "skyrimse",
        "",
        h.gameDir,
        h.stagingDir,
        h.method,
      );
      expect(
        entries
          .map(({ filePath, type }) => ({ filePath, type }))
          .sort((a, b) => a.filePath.localeCompare(b.filePath)),
      ).toEqual([
        { filePath: "blocked/nested/config.ini", type: "refchange" },
        { filePath: "held/config.ini", type: "refchange" },
      ]);
      expect.soft(boundary).toBe("captured");
      expect.soft(terminalBeforeRelease).toBe(0);
      expect.soft(savesBeforeRelease).toBe(0);
      expect(work.terminal).toHaveBeenCalledTimes(1);
      expect(dialog.shown).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(held, "utf8")).toBe("updated held");
      expect(fs.existsSync(h.inGame("held/config.ini"))).toBe(false);
      if (broken) {
        expect.soft((originalFailure as NodeJS.ErrnoException)?.code).toBe("ENOENT");
        expect.soft(result.error).toBe(originalFailure);
        expect.soft(result.error).toBeDefined();
        expect
          .soft(last[""])
          .toEqual([expect.objectContaining({ relPath: "blocked/nested/config.ini" })]);
        expect
          .soft(saved)
          .toEqual([expect.objectContaining({ relPath: "blocked/nested/config.ini" })]);
        expect(fs.existsSync(blocked)).toBe(false);
        expect(fs.readFileSync(h.inGame("blocked/nested/config.ini"), "utf8")).toBe(
          "updated blocked/nested",
        );
        expect(work.copies).toHaveBeenCalledTimes(1);
        expect(work.unlinks).toHaveBeenCalledTimes(1);
        expect(work.changed).toHaveBeenCalledTimes(0);
      } else {
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(blocked, "utf8")).toBe("updated blocked/nested");
        expect(fs.existsSync(h.inGame("blocked/nested/config.ini"))).toBe(false);
        expect(work.copies).toHaveBeenCalledTimes(2);
        expect(work.unlinks).toHaveBeenCalledTimes(2);
        expect(work.changed.mock.calls).toEqual([["skyrimse", "SomeMod"]]);
        expect(last[""]).toEqual([]);
        expect(saved).toEqual([]);
      }
      expect(work.saves).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      h.api.store.dispatch(confirmExternalChanges([], true));
      await work.drain();
      dialog.stop();
      h.api.events.removeAllListeners();
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
    }
  });
}
