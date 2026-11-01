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
        ? Promise.resolve(received.shift()!)
        : new Promise<IFileEntry[]>((resolve) => {
            waiting = resolve;
          }),
  };
}

for (const action of ["drop", "delete"] as const) {
  for (const failed of [false, true]) {
    test(`external ${action} settles late progress before persistence and default retry: failed=${failed}`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({
        files: { "denied/config.ini": "old denied", "held/config.ini": "old held" },
        profiles: { p: makeProfile({ id: "p" }) },
        activeProfileId: "p",
        mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
      });
      const source = (name: string) => path.join(h.stagingDir, `SomeMod/${name}/config.ini`);
      const deployed = (name: string) => h.inGame(`${name}/config.ini`);
      const target = action === "drop" ? deployed : source;
      const manifest = await h.deploy();
      h.setState((state) => {
        state.app = { ...state.app, instanceId: "external-removal-fixture" };
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
      for (const name of ["denied", "held"]) {
        expect(fs.statSync(deployed(name)).ino).toBe(fs.statSync(source(name)).ino);
        fs.unlinkSync(deployed(name));
        fs.writeFileSync(deployed(name), `updated ${name}`);
        expect(fs.statSync(deployed(name)).ino).not.toBe(fs.statSync(source(name)).ino);
      }
      const last = { "": manifest };
      const dialog = observeDialog(h);
      const entered = deferred();
      const release = deferred();
      const deniedSettled = deferred();
      const draining = deferred();
      const nativeWork: PromiseLike<unknown>[] = [];
      const publicWork: Promise<{ error: unknown }>[] = [];
      const track = <T extends PromiseLike<unknown>>(operation: T): T => {
        nativeWork.push(operation);
        return operation;
      };
      const removed = vi.fn();
      const terminal = vi.fn();
      const changed = vi.fn();
      h.api.events.on("mod-content-changed", changed);
      let heldFinished = false;
      let released = false;
      let originalFailure: unknown;
      const remove = native.removeAsync;
      const removals = vi.spyOn(native, "removeAsync").mockImplementation((filename, ...args) => {
        const held = filename === target("held");
        const operation = (held ? PromiseBB.resolve(release.promise) : PromiseBB.resolve())
          .then(() => remove(filename, ...args))
          .then(
            () => {
              removed(filename);
              if (held) heldFinished = true;
              if (filename === target("denied")) deniedSettled.resolve();
            },
            (error: unknown) => {
              if (filename === target("denied")) {
                originalFailure = error;
                deniedSettled.resolve();
              }
              throw error;
            },
          );
        track(operation);
        if (held) entered.resolve();
        return operation;
      });
      const savesBeforeCompletion: boolean[] = [];
      const save = activation.saveActivation;
      const saves = vi.spyOn(activation, "saveActivation").mockImplementation((...args) => {
        savesBeforeCompletion.push(!heldFinished);
        return track(save(...args));
      });
      const copy = atomic.copyFileAtomic;
      const copies = vi
        .spyOn(atomic, "copyFileAtomic")
        .mockImplementation((...args) => track(copy(...args)));
      const unlink = native.unlinkAsync;
      const unlinks = vi
        .spyOn(native, "unlinkAsync")
        .mockImplementation((...args) => track(unlink(...args)));
      const allSettled = Promise.allSettled.bind(Promise);
      let drainCount = 0;
      vi.spyOn(Promise, "allSettled").mockImplementation((operations) => {
        const result = allSettled(operations);
        if (!released && originalFailure !== undefined) {
          drainCount++;
          draining.resolve();
          track(result);
        }
        return result;
      });
      const begin = () => {
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
          await allSettled(nativeWork);
        }
      };
      try {
        const first = begin();
        const choices = await dialog.next();
        const initialChoices = choices
          .map(({ filePath, type }) => ({ filePath, type }))
          .sort((left, right) => left.filePath.localeCompare(right.filePath));
        if (failed) fs.chmodSync(path.dirname(target("denied")), 0o555);
        h.api.store.dispatch(
          confirmExternalChanges(
            choices.map((entry) => ({ ...entry, action })),
            false,
          ),
        );
        await entered.promise;
        await deniedSettled.promise;
        const boundary = failed
          ? await Promise.race([draining.promise.then(() => "drain"), first.then(() => "public")])
          : "success";
        const terminalBeforeRelease = terminal.mock.calls.length;
        const savesBeforeRelease = saves.mock.calls.length;
        released = true;
        release.resolve();
        const result = await first;
        await drain();
        const memory = last[""];
        const persisted = await activation.loadActivation(
          h.api,
          "skyrimse",
          "",
          h.gameDir,
          h.stagingDir,
          h.method,
        );
        fs.chmodSync(path.dirname(target("denied")), 0o755);
        last[""] = persisted;
        let defaults: IFileEntry[] = [];
        if (failed) {
          const retry = begin();
          defaults = await dialog.next();
          h.api.store.dispatch(confirmExternalChanges(defaults, false));
          await retry;
        }
        await drain();
        expect(initialChoices).toEqual([
          { filePath: "denied/config.ini", type: "refchange" },
          { filePath: "held/config.ini", type: "refchange" },
        ]);
        expect.soft(boundary).toBe(failed ? "drain" : "success");
        expect.soft(terminalBeforeRelease).toBe(0);
        expect.soft(savesBeforeRelease).toBe(0);
        expect.soft(drainCount).toBe(failed ? 1 : 0);
        expect(result.error).toBe(originalFailure);
        if (failed) expect(result.error).toMatchObject({ code: "EACCES" });
        expect
          .soft(terminal.mock.calls)
          .toEqual(failed ? [[originalFailure], [undefined]] : [[undefined]]);
        expect.soft(savesBeforeCompletion).toEqual(failed ? [false, false] : [false]);
        expect(memory).toEqual(
          failed ? [expect.objectContaining({ relPath: "denied/config.ini" })] : [],
        );
        expect
          .soft(persisted, "completed removal must be saved before public failure")
          .toEqual(memory);
        expect
          .soft(defaults.map(({ filePath, action }) => ({ filePath, action })))
          .toEqual(failed ? [{ filePath: "denied/config.ini", action: "newest" }] : []);
        expect(dialog.shown).toHaveBeenCalledTimes(failed ? 2 : 1);
        expect(changed).toHaveBeenCalledExactlyOnceWith("skyrimse", "SomeMod");
        expect(removed.mock.calls.filter(([filename]) => filename === target("held"))).toEqual([
          [target("held")],
        ]);
        expect(removed.mock.calls.filter(([filename]) => filename === target("denied"))).toEqual(
          failed ? [] : [[target("denied")]],
        );
        expect(
          removals.mock.calls.filter(([filename]) => filename === target("held")),
        ).toHaveLength(1);
        expect(
          removals.mock.calls.filter(([filename]) => filename === target("denied")),
        ).toHaveLength(1);
        expect(copies).toHaveBeenCalledTimes(failed ? 1 : 0);
        expect(unlinks).toHaveBeenCalledTimes(failed ? 1 : 0);
        if (action === "drop") {
          expect
            .soft(fs.existsSync(source("held")), "default retry must retain completed Drop staging")
            .toBe(true);
          if (fs.existsSync(source("held")))
            expect(fs.readFileSync(source("held"), "utf8")).toBe("old held");
          expect(fs.existsSync(deployed("held"))).toBe(false);
        } else {
          expect(fs.existsSync(source("held"))).toBe(false);
          expect
            .soft(
              fs.existsSync(deployed("held")),
              "default retry must retain completed Delete output",
            )
            .toBe(true);
          if (fs.existsSync(deployed("held")))
            expect(fs.readFileSync(deployed("held"), "utf8")).toBe("updated held");
        }
        expect(fs.existsSync(source("denied"))).toBe(failed || action === "drop");
        if (fs.existsSync(source("denied")))
          expect(fs.readFileSync(source("denied"), "utf8")).toBe(
            failed ? "updated denied" : "old denied",
          );
        expect(fs.existsSync(deployed("denied"))).toBe(!failed && action === "delete");
        if (fs.existsSync(deployed("denied")))
          expect(fs.readFileSync(deployed("denied"), "utf8")).toBe("updated denied");
        expect(last[""]).toEqual([]);
        expect(
          await activation.loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method),
        ).toEqual([]);
        expect(h.errorNotifications).toEqual([]);
      } finally {
        released = true;
        release.resolve();
        h.api.store.dispatch(confirmExternalChanges([], true));
        await drain();
        fs.chmodSync(path.dirname(target("denied")), 0o755);
        dialog.stop();
        h.api.events.removeAllListeners();
        await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
      }
    });
  }
}
