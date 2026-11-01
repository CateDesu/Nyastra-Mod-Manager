import fs from "node:fs";
import path from "node:path";

import PromiseBB from "bluebird";
import { expect, vi, afterEach } from "vitest";

import { makeProfile, makeMod } from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import type { IDeploymentHarness } from "../../../test-utils/deploymentTest";
import { UserCanceled } from "../../../util/CustomErrors";
import * as atomic from "../../../util/fsAtomic";
import { setExternalChanges, confirmExternalChanges } from "../actions/session";
import type { IFileEntry } from "../types/IFileEntry";
import { loadActivation, saveActivation } from "./activationStore";
import { dealWithExternalChanges } from "./externalChanges";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.restoreAllMocks());
function dialogObserver(h: IDeploymentHarness) {
  let count = 0;
  let last: unknown;
  const pending: Array<{ resolve: (v: IFileEntry[]) => void }> = [];
  const received: IFileEntry[][] = [];
  const stop = h.api.store.subscribe(() => {
    const entry = h.dispatched.at(-1);
    if (
      entry?.type !== String(setExternalChanges) ||
      !Array.isArray(entry.payload) ||
      !entry.payload.length
    )
      return;
    if (last === entry) return;
    last = entry;
    count++;
    const payload = entry.payload as IFileEntry[];
    const waiter = pending.shift();
    if (waiter) waiter.resolve(payload);
    else received.push(payload);
  });
  return {
    next: () =>
      received.length > 0
        ? Promise.resolve(received.shift()!)
        : new Promise<IFileEntry[]>((resolve) => pending.push({ resolve })),
    count: () => count,
    stop,
  };
}
for (const schedule of [
  "normal",
  "canceled",
  "denied",
  "vanished",
  "unreadable",
  "staging-denied",
] as const) {
  test(`public external import retains a recoverable source with ${schedule}`, async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({
      files: { "config.ini": "original staging" },
      profiles: { p: makeProfile({ id: "p" }) },
      activeProfileId: "p",
      mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
    });
    const source = path.join(h.stagingDir, "SomeMod/config.ini");
    const deployed = h.inGame("config.ini");
    const manifest = await h.deploy();
    h.setState((state) => {
      state.app = { ...state.app, instanceId: "external-import-fixture" };
    });
    await saveActivation(
      "skyrimse",
      "",
      h.getState().app.instanceId,
      h.gameDir,
      h.stagingDir,
      manifest,
      h.method.id,
    );
    fs.unlinkSync(deployed);
    fs.writeFileSync(deployed, "updated by game");
    const last = { "": manifest };
    const observer = dialogObserver(h);
    const work: Promise<unknown>[] = [];
    const changes = vi.fn();
    h.api.events.on("mod-content-changed", changes);
    const begin = () => {
      const p = Promise.resolve(
        dealWithExternalChanges(h.api, h.method, "p", h.stagingDir, { "": h.gameDir }, last),
      );
      work.push(p);
      void p.catch(() => undefined);
      return p;
    };
    try {
      const first = begin();
      const entries = await observer.next();
      expect(entries).toEqual([
        expect.objectContaining({ type: "refchange", source: "SomeMod", filePath: "config.ini" }),
      ]);
      if (schedule === "denied") fs.chmodSync(h.gameDir, 0o555);
      if (schedule === "vanished") fs.unlinkSync(deployed);
      if (schedule === "unreadable") fs.chmodSync(deployed, 0o000);
      if (schedule === "staging-denied") fs.chmodSync(path.dirname(source), 0o555);
      h.api.store.dispatch(
        confirmExternalChanges(
          entries.map((entry) => ({ ...entry, action: "import" as const })),
          schedule === "canceled",
        ),
      );
      const outcome = await first.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      await Promise.allSettled(work);
      await tick();
      if (["denied", "unreadable", "staging-denied"].includes(schedule)) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect((outcome.reason as NodeJS.ErrnoException).code).toBe("EACCES");
        expect(last[""]).toEqual(manifest);
        expect(changes).toHaveBeenCalledTimes(0);
        const after = fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null;
        console.log(
          "IMPORT_DENIED",
          JSON.stringify({
            source: after,
            deployedExists: fs.existsSync(deployed),
            manifest: last[""],
          }),
        );
        expect
          .soft(after, "a denied import must retain valid staged bytes")
          .toBe(schedule === "denied" ? "updated by game" : "original staging");
        fs.chmodSync(h.gameDir, 0o755);
        fs.chmodSync(path.dirname(source), 0o755);
        fs.chmodSync(deployed, 0o644);
        expect(fs.readFileSync(deployed, "utf8")).toBe("updated by game");
        last[""] = await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method);
        const retry = begin();
        const defaults = await observer.next();
        expect(defaults).toEqual([
          expect.objectContaining({ type: "refchange", source: "SomeMod", action: "newest" }),
        ]);
        console.log("IMPORT_RETRY_DEFAULTS", JSON.stringify(defaults));
        h.api.store.dispatch(confirmExternalChanges(defaults, false));
        await retry;
        await Promise.allSettled(work);
        await tick();
        const afterRetry = fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null;
        console.log(
          "IMPORT_RETRY",
          JSON.stringify({
            source: afterRetry,
            deployedExists: fs.existsSync(deployed),
            manifest: last[""],
          }),
        );
        expect
          .soft(afterRetry, "retry must preserve the imported updated bytes")
          .toBe("updated by game");
        expect(observer.count()).toBe(2);
        expect(changes).toHaveBeenCalledTimes(1);
      } else if (schedule === "canceled") {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(UserCanceled);
        expect(fs.readFileSync(source, "utf8")).toBe("original staging");
        expect(fs.readFileSync(deployed, "utf8")).toBe("updated by game");
        expect(last[""]).toEqual(manifest);
        expect(observer.count()).toBe(1);
        expect(changes).toHaveBeenCalledTimes(0);
      } else {
        expect(outcome.status).toBe("fulfilled");
        const bytes = fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null;
        console.log(
          "IMPORT_RESULT",
          JSON.stringify({
            schedule,
            source: bytes,
            deployedExists: fs.existsSync(deployed),
            manifest: last[""],
          }),
        );
        expect
          .soft(bytes, "a disappeared input must not erase the only staging copy")
          .toBe(schedule === "normal" ? "updated by game" : "original staging");
        expect(fs.existsSync(deployed)).toBe(false);
        expect(last[""]).toEqual([]);
        expect(
          await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method),
        ).toEqual([]);
        expect(observer.count()).toBe(1);
        expect(changes).toHaveBeenCalledTimes(1);
      }
    } finally {
      fs.chmodSync(h.gameDir, 0o755);
      fs.chmodSync(path.dirname(source), 0o755);
      if (fs.existsSync(deployed)) fs.chmodSync(deployed, 0o644);
      h.api.store.dispatch(confirmExternalChanges([], true));
      await Promise.allSettled(work);
      observer.stop();
      h.api.events.removeAllListeners();
      await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
    }
  });
}

test("external import retry preserves another completed import in the same batch", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "denied.ini": "old denied", "complete.ini": "old complete" },
    profiles: { p: makeProfile({ id: "p" }) },
    activeProfileId: "p",
    mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
  });
  const manifest = await h.deploy();
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "external-import-fixture" };
  });
  await saveActivation(
    "skyrimse",
    "",
    h.getState().app.instanceId,
    h.gameDir,
    h.stagingDir,
    manifest,
    h.method.id,
  );
  const last = { "": manifest };
  for (const name of ["denied", "complete"]) {
    fs.unlinkSync(h.inGame(`${name}.ini`));
    fs.writeFileSync(h.inGame(`${name}.ini`), `updated ${name}`);
  }
  const observer = dialogObserver(h);
  const work: Promise<unknown>[] = [];
  const changes = vi.fn();
  h.api.events.on("mod-content-changed", changes);
  const begin = () => {
    const result = Promise.resolve(
      dealWithExternalChanges(h.api, h.method, "p", h.stagingDir, { "": h.gameDir }, last),
    );
    work.push(result);
    void result.catch(() => undefined);
    return result;
  };
  try {
    const first = begin();
    const entries = await observer.next();
    fs.chmodSync(h.inGame("denied.ini"), 0o000);
    h.api.store.dispatch(
      confirmExternalChanges(
        entries.map((entry) => ({ ...entry, action: "import" as const })),
        false,
      ),
    );
    const error = await first.then(
      () => undefined,
      (error) => error as NodeJS.ErrnoException,
    );
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    await tick();
    expect(error?.code).toBe("EACCES");
    fs.chmodSync(h.inGame("denied.ini"), 0o644);
    last[""] = await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method);
    const retry = begin();
    const defaults = await observer.next();
    h.api.store.dispatch(confirmExternalChanges(defaults, false));
    await retry;
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    await tick();
    expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/denied.ini"), "utf8")).toBe(
      "updated denied",
    );
    expect(
      fs.existsSync(path.join(h.stagingDir, "SomeMod/complete.ini")),
      "retry must retain the completed import",
    ).toBe(true);
    if (fs.existsSync(path.join(h.stagingDir, "SomeMod/complete.ini")))
      expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/complete.ini"), "utf8")).toBe(
        "updated complete",
      );
    expect(last[""]).toEqual([]);
    expect(await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method)).toEqual(
      [],
    );
    expect(observer.count()).toBe(2);
    expect(changes).toHaveBeenCalledTimes(1);
  } finally {
    if (fs.existsSync(h.inGame("denied.ini"))) fs.chmodSync(h.inGame("denied.ini"), 0o644);
    h.api.store.dispatch(confirmExternalChanges([], true));
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    observer.stop();
    h.api.events.removeAllListeners();
    await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
  }
});

test("external import retry retains staging after dropping another file in the same batch", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "denied.ini": "old denied", "complete.ini": "old complete" },
    profiles: { p: makeProfile({ id: "p" }) },
    activeProfileId: "p",
    mods: { skyrimse: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
  });
  const manifest = await h.deploy();
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "external-import-fixture" };
  });
  await saveActivation(
    "skyrimse",
    "",
    h.getState().app.instanceId,
    h.gameDir,
    h.stagingDir,
    manifest,
    h.method.id,
  );
  const last = { "": manifest };
  for (const name of ["denied", "complete"]) {
    fs.unlinkSync(h.inGame(`${name}.ini`));
    fs.writeFileSync(h.inGame(`${name}.ini`), `updated ${name}`);
  }
  const observer = dialogObserver(h);
  const work: Promise<unknown>[] = [];
  const changes = vi.fn();
  h.api.events.on("mod-content-changed", changes);
  const begin = () => {
    const result = Promise.resolve(
      dealWithExternalChanges(h.api, h.method, "p", h.stagingDir, { "": h.gameDir }, last),
    );
    work.push(result);
    void result.catch(() => undefined);
    return result;
  };
  try {
    const first = begin();
    const entries = await observer.next();
    fs.chmodSync(h.inGame("denied.ini"), 0o000);
    h.api.store.dispatch(
      confirmExternalChanges(
        entries.map((entry) => ({
          ...entry,
          action: entry.filePath === "complete.ini" ? ("drop" as const) : ("import" as const),
        })),
        false,
      ),
    );
    const error = await first.then(
      () => undefined,
      (error) => error as NodeJS.ErrnoException,
    );
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    await tick();
    expect(error?.code).toBe("EACCES");
    fs.chmodSync(h.inGame("denied.ini"), 0o644);
    last[""] = await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method);
    const retry = begin();
    const defaults = await observer.next();
    h.api.store.dispatch(confirmExternalChanges(defaults, false));
    await retry;
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    await tick();
    expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/denied.ini"), "utf8")).toBe(
      "updated denied",
    );
    expect(
      fs.existsSync(path.join(h.stagingDir, "SomeMod/complete.ini")),
      "retry must retain the completed import",
    ).toBe(true);
    if (fs.existsSync(path.join(h.stagingDir, "SomeMod/complete.ini")))
      expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/complete.ini"), "utf8")).toBe(
        "old complete",
      );
    expect(last[""]).toEqual([]);
    expect(await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method)).toEqual(
      [],
    );
    expect(observer.count()).toBe(2);
    expect(changes).toHaveBeenCalledTimes(1);
  } finally {
    if (fs.existsSync(h.inGame("denied.ini"))) fs.chmodSync(h.inGame("denied.ini"), 0o644);
    h.api.store.dispatch(confirmExternalChanges([], true));
    await Promise.all(work.map((p) => p.catch(() => undefined)));
    observer.stop();
    h.api.events.removeAllListeners();
    await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
  }
});

test("external import waits for admitted native copies before reporting a failure", async ({
  makeDeployment,
}) => {
  const h = makeDeployment({
    files: { "denied.ini": "old denied", "held.ini": "old held" },
    profiles: { p: makeProfile({ id: "p" }) },
    activeProfileId: "p",
  });
  const manifest = await h.deploy();
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "external-import-fixture" };
  });
  await saveActivation(
    "skyrimse",
    "",
    h.getState().app.instanceId,
    h.gameDir,
    h.stagingDir,
    manifest,
    h.method.id,
  );
  const last = { "": manifest };
  for (const name of ["denied", "held"]) {
    fs.unlinkSync(h.inGame(`${name}.ini`));
    fs.writeFileSync(h.inGame(`${name}.ini`), `updated ${name}`);
  }
  const observer = dialogObserver(h);
  const entered = deferred();
  const failed = deferred();
  const release = deferred();
  const nativeWork: PromiseLike<unknown>[] = [];
  const copy = atomic.copyFileAtomic;
  const copying = vi.spyOn(atomic, "copyFileAtomic").mockImplementation((from, to) => {
    const operation = from.endsWith("held.ini")
      ? PromiseBB.resolve(release.promise).then(() => copy(from, to))
      : copy(from, to).catch((error) => {
          failed.resolve();
          throw error;
        });
    nativeWork.push(operation);
    if (from.endsWith("held.ini")) entered.resolve();
    return operation;
  });
  let delivered = false;
  const resolving = Promise.resolve(
    dealWithExternalChanges(h.api, h.method, "p", h.stagingDir, { "": h.gameDir }, last),
  );
  const outcome = resolving
    .then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    )
    .then((value) => {
      delivered = true;
      return value;
    });
  try {
    const choices = await observer.next();
    fs.chmodSync(h.inGame("denied.ini"), 0o000);
    h.api.store.dispatch(
      confirmExternalChanges(
        choices.map((entry) => ({ ...entry, action: "import" as const })),
        false,
      ),
    );
    await entered.promise;
    await failed.promise;
    await tick();
    await tick();
    const deliveredBeforeRelease = delivered;
    release.resolve();
    const result = await outcome;
    await Promise.all(nativeWork.map((p) => Promise.resolve(p).catch(() => undefined)));
    await tick();
    expect(deliveredBeforeRelease).toBe(false);
    expect((result.error as NodeJS.ErrnoException)?.code).toBe("EACCES");
    expect(copying).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/denied.ini"), "utf8")).toBe(
      "old denied",
    );
    expect(fs.readFileSync(path.join(h.stagingDir, "SomeMod/held.ini"), "utf8")).toBe(
      "updated held",
    );
    expect(last[""]).toEqual([expect.objectContaining({ relPath: "denied.ini" })]);
    expect(await loadActivation(h.api, "skyrimse", "", h.gameDir, h.stagingDir, h.method)).toEqual(
      last[""],
    );
    expect(observer.count()).toBe(1);
  } finally {
    release.resolve();
    h.api.store.dispatch(confirmExternalChanges([], true));
    await outcome;
    await Promise.all(nativeWork.map((p) => Promise.resolve(p).catch(() => undefined)));
    fs.chmodSync(h.inGame("denied.ini"), 0o644);
    observer.stop();
    await h.method.cancel("skyrimse", h.gameDir, h.stagingDir);
  }
});
