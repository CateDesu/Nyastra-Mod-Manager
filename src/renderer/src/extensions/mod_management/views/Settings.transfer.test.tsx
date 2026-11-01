import fs from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, expect, vi } from "vitest";

import { makeApiHarness, makeMod, makeProfile } from "../../../test-utils/builders";
import { test } from "../../../test-utils/deploymentTest";
import * as nativeFs from "../../../util/fs";
import { prepareStagingTransfer, STAGING_TRANSFER_TAG } from "../../../util/transferPath";
import { DOWNLOADS_DIR_TAG } from "../../download_management/util/downloadDirectory";
import { getGame } from "../../gamemode_management/util/getGame";
import { setInstallPath } from "../actions/settings";
import { setTransferMods } from "../actions/transactions";
import init from "../index";
import type InstallManager from "../InstallManager";
import { settingsReducer } from "../reducers/settings";
import { transactionsReducer } from "../reducers/transactions";
import { saveActivation } from "../util/activationStore";
import * as methods from "../util/deploymentMethods";
import Settings from "./Settings";
const observed = vi.hoisted(() => ({ managers: [] as any[] }));
vi.mock("../../../controls/ComponentEx", async (load) => ({
  ...(await load<object>()),
  connect: () => (component: unknown) => component,
  translate: () => (component: unknown) => component,
}));
vi.mock("../InstallManager", async (load) => {
  const { default: Manager } = await load<{ default: typeof InstallManager }>();
  return {
    default: class extends Manager {
      constructor(...args: ConstructorParameters<typeof Manager>) {
        super(...args);
        observed.managers.push(this);
      }
    },
  };
});
function nodes(element: any): any[] {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray((element.props as any).children).flatMap(nodes)];
}
afterEach(() => {
  vi.restoreAllMocks();
  methods.getAllActivators().splice(0);
});
for (const kind of [
  "empty",
  "new",
  "identical",
  "same-instance",
  "different-instance",
  "merge",
  "other-merge",
  "empty-denied",
  "merge-denied",
  "other-denied",
  "fallback",
  "fallback-conflict",
  "copy-volume",
  "copy-volume-conflict",
  "tag-directory",
  "downloads-tag",
  "held-conflict",
  "fallback-symlink",
  "copy-file-denied",
  "private-cleanup-denied",
] as const) {
  const failed = kind.endsWith("denied");
  const existing = ![
    "empty",
    "new",
    "empty-denied",
    "private-cleanup-denied",
    "fallback",
    "fallback-symlink",
    "copy-volume",
  ].includes(kind);
  const different = ["different-instance", "other-merge", "other-denied"].includes(kind);
  const conflict = [
    "same-instance",
    "different-instance",
    "fallback-conflict",
    "copy-volume-conflict",
    "tag-directory",
    "held-conflict",
  ].includes(kind);
  test(`Settings staging Apply preserves bytes and cleanup ownership: ${kind}`, async ({
    makeDeployment,
  }) => {
    const gameId = "maxb-transfer";
    const physical = makeDeployment({ gameId, files: { "config.ini": "current mod bytes" } });
    const h = {
      ...physical,
      ...makeApiHarness(
        {
          profiles: { p: makeProfile({ id: "p", gameId }) },
          activeProfileId: "p",
          lastActiveProfile: { [gameId]: "p" },
          mods: { [gameId]: { SomeMod: makeMod({ id: "SomeMod", installationPath: "SomeMod" }) } },
        },
        [
          { path: ["settings", "mods"], reducer: settingsReducer },
          { path: ["persistent", "transactions"], reducer: transactionsReducer },
        ],
      ),
    };
    h.setState((s) => {
      s.app = { ...s.app, instanceId: "maxb-transfer" };
      s.settings.mods = {
        ...settingsReducer.defaults,
        ...s.settings.mods,
        activator: { [gameId]: h.method.id },
        installPath: { [gameId]: h.stagingDir },
      };
      s.settings.window = { useModernLayout: false } as any;
      s.session.base = { toolsRunning: {}, activity: { mods: [] } } as any;
      s.settings.gameMode.discovered[gameId] = { path: h.gameDir };
    });
    const game = getGame(gameId);
    game.queryModPath = () => h.gameDir;
    methods.registerDeploymentMethod(h.method);
    const original = await h.deploy();
    await saveActivation(
      gameId,
      "",
      "maxb-transfer",
      h.gameDir,
      h.stagingDir,
      original,
      h.method.id,
    );
    const destination = path.join(path.dirname(h.stagingDir), "destination");
    if (kind !== "new") fs.mkdirSync(destination);
    const source = path.join(h.stagingDir, "SomeMod/config.ini");
    const target = path.join(destination, "SomeMod/config.ini");
    const tag = "__vortex_staging_folder";
    fs.writeFileSync(
      path.join(h.stagingDir, tag),
      JSON.stringify({ instance: "maxb-transfer", game: gameId }),
    );
    if (existing) {
      fs.writeFileSync(
        path.join(destination, tag),
        JSON.stringify({ instance: different ? "other-instance" : "maxb-transfer", game: gameId }),
      );
      fs.writeFileSync(path.join(destination, "unrelated.txt"), "preexisting unrelated");
    }
    if (kind !== "new") expect(fs.statSync(h.stagingDir).dev).toBe(fs.statSync(destination).dev);
    if (kind === "identical" || (conflict && kind !== "tag-directory")) {
      fs.mkdirSync(path.dirname(target));
      if (kind === "identical") fs.linkSync(source, target);
      else fs.writeFileSync(target, "stale destination bytes");
      expect(fs.statSync(source).ino === fs.statSync(target).ino).toBe(kind === "identical");
    }
    if (conflict)
      fs.writeFileSync(path.join(h.stagingDir, "SomeMod", "extra.ini"), "additional source bytes");
    if (kind === "fallback-symlink") {
      fs.renameSync(source, path.join(path.dirname(source), "source-original"));
      fs.symlinkSync("source-original", source);
    }
    const oldTag = existing ? fs.readFileSync(path.join(destination, tag), "utf8") : undefined;
    if (kind === "downloads-tag") {
      fs.writeFileSync(path.join(h.stagingDir, DOWNLOADS_DIR_TAG), "source downloads tag");
      fs.writeFileSync(path.join(destination, DOWNLOADS_DIR_TAG), "destination downloads tag");
    }
    const callbacks: Array<() => void> = [];
    const checks = new Map<string, () => Promise<any>>();
    const context: any = new Proxy(
      { api: h.api },
      {
        get: (obj, key) =>
          key in obj
            ? obj[key]
            : key === "once"
              ? (cb: () => void) => callbacks.push(cb)
              : key === "registerTest"
                ? (name: string, _event: string, cb: () => Promise<any>) => checks.set(name, cb)
                : () => undefined,
      },
    );
    init(context);
    callbacks.forEach((cb) => cb());
    expect(observed.managers).toHaveLength(1);
    const manager = observed.managers[0];
    const native: any[] = [];
    for (const key of [
      "linkAsync",
      "copyAsync",
      "removeAsync",
      "writeFileAsync",
      "ensureDirAsync",
      "symlinkAsync",
    ] as const) {
      const original = nativeFs[key];
      vi.spyOn(nativeFs, key).mockImplementation((...args: any[]) => {
        const operation = (original as any)(...args);
        native.push(operation);
        void Promise.resolve(operation).catch(() => {});
        return operation;
      });
    }
    const copy = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, "copyFile").mockImplementation((...args) => {
      const operation = copy(...args);
      native.push(operation);
      void operation.catch(() => {});
      return operation;
    });
    if (kind.startsWith("fallback")) {
      const link = vi.mocked(nativeFs.linkAsync).getMockImplementation();
      vi.mocked(nativeFs.linkAsync).mockImplementation((from, to, options) => {
        if (from !== source) return link(from, to, options);
        const operation = Promise.reject(
          Object.assign(new Error("unsupported link fixture"), { code: "ENOTSUP" }),
        );
        native.push(operation);
        void operation.catch(() => {});
        return operation as any;
      });
    }
    if (kind.startsWith("copy-volume") || kind === "copy-file-denied") {
      const stat = nativeFs.statAsync;
      vi.spyOn(nativeFs, "statAsync").mockImplementation(((file: string, ...args: any[]) =>
        (stat as any)(file, ...args).then((result: any) =>
          file === destination
            ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
                dev: result.dev + 1,
              })
            : result,
        )) as any);
    }
    let release!: () => void;
    let failedLink!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failureObserved = new Promise<void>((resolve) => {
      failedLink = resolve;
    });
    const admissionObserved = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    if (kind === "held-conflict") {
      const link = vi.mocked(nativeFs.linkAsync).getMockImplementation();
      vi.mocked(nativeFs.linkAsync).mockImplementation((from, to, options) => {
        if (from.endsWith("/extra.ini")) {
          const operation = gate.then(() => link(from, to, options));
          native.push(operation);
          admitted();
          return operation as any;
        }
        const operation = link(from, to, options);
        void operation.catch((error) => {
          if (error.code === "EEXIST") failedLink();
        });
        return operation;
      });
    }
    const removeSource = vi.mocked(nativeFs.removeAsync).getMockImplementation();
    const sourceCleanup = vi.fn();
    vi.mocked(nativeFs.removeAsync).mockImplementation((...args) => {
      if (args[0] === h.stagingDir)
        sourceCleanup(fs.existsSync(path.join(destination, STAGING_TRANSFER_TAG)));
      return removeSource(...args);
    });
    const purgeCallbacks = vi.fn();
    const handler = h.api.events.listeners("purge-mods")[0] as any;
    h.api.events.removeAllListeners("purge-mods");
    h.api.events.on("purge-mods", (fallback, cb) => {
      const operation = handler(fallback, (error) => {
        purgeCallbacks(error);
        if (failed && !error)
          fs.chmodSync(kind === "copy-file-denied" ? source : path.dirname(source), 0);
        if (kind === "private-cleanup-denied" && !error) fs.chmodSync(destination, 0);
        if (kind === "tag-directory" && !error) {
          fs.rmSync(path.join(destination, tag));
          fs.mkdirSync(path.join(destination, tag));
          fs.writeFileSync(path.join(destination, tag, "keep"), "tag directory bytes");
        }
        cb(error);
      });
      native.push(operation);
      return operation;
    });
    const changed = vi.fn((id, value) => h.api.store.dispatch(setInstallPath(id, value)));
    const transfers = vi.fn((id, value) => h.api.store.dispatch(setTransferMods(id, value)));
    const errors = vi.fn();
    const dialogs = vi.fn(async (type, title, content, actions) => {
      const answer = actions.find((a) => a.label === "Continue") ?? actions[0];
      answer.action?.();
      return { action: answer.label, input: {} };
    });
    const ui: any = new (Settings as any)({
      activators: [h.method],
      gameMode: gameId,
      currentActivator: h.method.id,
      game,
      discovery: { path: h.gameDir },
      installPath: h.stagingDir,
      modPaths: { "": h.gameDir },
      modActivity: [],
      instanceId: "maxb-transfer",
      t: (s) => s,
      onSetInstallPath: changed,
      onSetTransfer: transfers,
      onShowError: errors,
      onShowDialog: dialogs,
    });
    ui.setState = (value) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    ui.nextState.supportedActivators = [h.method];
    const input = nodes(ui.render()).find((x) => x.props?.className === "install-path-input");
    input.props.onChange({ target: { value: destination } });
    const apply = nodes(ui.render()).find((x) => x.props?.children === "Apply" && x.props?.onClick);
    expect(apply.props.disabled).toBe(false);
    const terminal = vi.fn();
    const operation = Promise.resolve(apply.props.onClick()).then(() => terminal());
    let boundary: unknown;
    let terminalBeforeRelease: unknown;
    const drain = async () => {
      await operation;
      let count = -1;
      while (count !== native.length) {
        count = native.length;
        await Promise.allSettled(native);
        for (const limiter of [manager.mInstallLimit, manager.mDependencyPipelineLimit])
          await limiter.mEndOfQueue;
      }
    };
    try {
      if (kind === "held-conflict") {
        const admission = await Promise.race([
          admissionObserved.then(() => "admitted"),
          operation.then(() => "public-before-admission"),
        ]);
        boundary =
          admission === "admitted"
            ? await Promise.race([
                failureObserved.then(() => "native-collision"),
                operation.then(() => "public"),
              ])
            : admission;
        terminalBeforeRelease = terminal.mock.calls.length;
        release();
      }
      await drain();
      for (const limiter of [manager.mInstallLimit, manager.mDependencyPipelineLimit]) {
        await limiter.mEndOfQueue;
        expect(limiter.mNext).toBeUndefined();
        expect(limiter.mLimit).toBe(limiter.mInitialLimit);
      }
      expect(manager.mActiveInstalls.size).toBe(0);
      expect(manager.mPendingInstalls.size).toBe(0);
      expect(manager.mRunningInstalls.size).toBe(0);
      if (kind === "held-conflict") {
        expect(boundary).toBe("native-collision");
        expect(terminalBeforeRelease).toBe(0);
      }
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(purgeCallbacks).toHaveBeenCalledExactlyOnceWith(null);
      if (conflict) {
        expect
          .soft(fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null)
          .toBe("current mod bytes");
        if (kind !== "tag-directory")
          expect
            .soft(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null)
            .toBe("stale destination bytes");
        expect
          .soft(
            fs.existsSync(path.join(h.stagingDir, "SomeMod", "extra.ini"))
              ? fs.readFileSync(path.join(h.stagingDir, "SomeMod", "extra.ini"), "utf8")
              : null,
          )
          .toBe("additional source bytes");
        expect
          .soft(
            fs.existsSync(path.join(destination, "SomeMod", "extra.ini"))
              ? fs.readFileSync(path.join(destination, "SomeMod", "extra.ini"), "utf8")
              : null,
          )
          .toBe("additional source bytes");
      }
      if (failed || conflict) {
        expect(changed).toHaveBeenCalledTimes(0);
        expect(errors).toHaveBeenCalledTimes(kind === "private-cleanup-denied" ? 2 : 1);
        if (kind === "private-cleanup-denied")
          expect(errors.mock.calls[1][1]).toMatchObject({ code: "EACCES" });
        expect(errors.mock.calls[0][1]).toMatchObject({ code: failed ? "EACCES" : "EEXIST" });
        expect(h.getState().settings.mods.installPath[gameId]).toBe(h.stagingDir);
        fs.chmodSync(path.dirname(source), 0o700);
        if (kind === "copy-file-denied" && fs.existsSync(source)) fs.chmodSync(source, 0o600);
        expect(fs.readFileSync(source, "utf8")).toBe("current mod bytes");
      } else {
        expect(changed).toHaveBeenCalledExactlyOnceWith(gameId, destination);
        expect(errors).toHaveBeenCalledTimes(0);
        expect(h.getState().settings.mods.installPath[gameId]).toBe(destination);
        expect(fs.readFileSync(target, "utf8")).toBe("current mod bytes");
        expect(fs.existsSync(source)).toBe(false);
      }
      if (kind === "fallback-symlink") {
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(target)).toBe("source-original");
      }
      expect(sourceCleanup.mock.calls).toEqual(failed || conflict ? [] : [[false]]);
      if (kind === "private-cleanup-denied") {
        expect(h.getState().persistent.transactions.transfer[gameId]).toBe(destination);
        expect(transfers.mock.calls).toEqual([[gameId, destination]]);
        fs.chmodSync(destination, 0o700);
        expect(fs.existsSync(path.join(destination, STAGING_TRANSFER_TAG))).toBe(true);
        const recovery = await checks.get("verify-mod-transfers")();
        expect(recovery.description.short).toBe("Folder transfer was interrupted");
        await recovery.automaticFix();
        await drain();
        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readFileSync(source, "utf8")).toBe("current mod bytes");
      }
      expect(h.getState().persistent.transactions.transfer[gameId]).toBeUndefined();
      expect(transfers.mock.calls).toEqual(
        kind === "private-cleanup-denied"
          ? [[gameId, destination]]
          : [
              [gameId, destination],
              [gameId, undefined],
            ],
      );
      expect(manager.mDependencyAttempts.size).toBe(0);
      expect(dialogs).toHaveBeenCalledTimes(different ? 1 : 0);
      expect(fs.existsSync(h.inGame("config.ini"))).toBe(false);
      const victim = path.join(destination, "unrelated.txt");

      if (existing)
        expect(fs.existsSync(victim) ? fs.readFileSync(victim, "utf8") : null).toBe(
          "preexisting unrelated",
        );
      if (failed && !existing) expect(fs.existsSync(destination)).toBe(false);
      else expect(fs.existsSync(path.join(destination, STAGING_TRANSFER_TAG))).toBe(false);
      if (conflict && kind !== "tag-directory")
        expect(fs.readFileSync(target, "utf8")).toBe("stale destination bytes");
      if (kind === "tag-directory")
        expect(fs.readFileSync(path.join(destination, tag, "keep"), "utf8")).toBe(
          "tag directory bytes",
        );
      else if (existing) expect(fs.readFileSync(path.join(destination, tag), "utf8")).toBe(oldTag);
      if (kind === "downloads-tag")
        expect(fs.readFileSync(path.join(destination, DOWNLOADS_DIR_TAG), "utf8")).toBe(
          "destination downloads tag",
        );
      if (kind === "fallback-symlink") {
        expect(nativeFs.symlinkAsync).toHaveBeenCalledExactlyOnceWith("source-original", target);
      } else if (
        kind.startsWith("fallback") ||
        kind.startsWith("copy-volume") ||
        kind === "copy-file-denied"
      ) {
        expect(fs.promises.copyFile).toHaveBeenCalled();
      }
      expect(await checks.get("verify-mod-transfers")()).toBeUndefined();
      if (existing && (failed || conflict)) {
        h.api.store.dispatch(setTransferMods(gameId, destination));
        const recovery = await checks.get("verify-mod-transfers")();
        expect(recovery.description.short).toBe("Folder transfer was interrupted");
        await recovery.automaticFix();
        await drain();
        expect(h.getState().persistent.transactions.transfer[gameId]).toBeUndefined();
        expect(fs.readFileSync(source, "utf8")).toBe("current mod bytes");
        expect(fs.readFileSync(victim, "utf8")).toBe("preexisting unrelated");
        if (conflict && kind !== "tag-directory")
          expect(fs.readFileSync(target, "utf8")).toBe("stale destination bytes");
        if (kind === "tag-directory")
          expect(fs.readFileSync(path.join(destination, tag, "keep"), "utf8")).toBe(
            "tag directory bytes",
          );
      }
    } finally {
      release();
      if (fs.existsSync(destination)) fs.chmodSync(destination, 0o700);
      if (fs.existsSync(path.dirname(source))) fs.chmodSync(path.dirname(source), 0o700);
      if (kind === "copy-file-denied" && fs.existsSync(source)) fs.chmodSync(source, 0o600);
      await drain();
      h.api.events.removeAllListeners();
      await h.method.cancel(gameId, h.gameDir, h.stagingDir);
    }
  });
}

for (const kind of [
  "private",
  "legacy",
  "empty-legacy",
  "malformed",
  "replaced",
  "selected",
  "missing-source",
  "cleanup-denied",
  "changed-marker",
] as const) {
  test(`registered pending staging recovery preserves unowned bytes: ${kind}`, async ({
    makeDeployment,
  }) => {
    const gameId = "staging-recovery";
    const physical = makeDeployment({ gameId, files: { "config.ini": "source bytes" } });
    const h = {
      ...physical,
      ...makeApiHarness(
        {
          profiles: { p: makeProfile({ id: "p", gameId }) },
          activeProfileId: "p",
          lastActiveProfile: { [gameId]: "p" },
        },
        [
          { path: ["settings", "mods"], reducer: settingsReducer },
          { path: ["persistent", "transactions"], reducer: transactionsReducer },
        ],
      ),
    };
    h.setState((s) => {
      s.app = { ...s.app, instanceId: gameId };
      s.settings.mods = {
        ...settingsReducer.defaults,
        ...s.settings.mods,
        installPath: { [gameId]: h.stagingDir },
      };
      s.session.base = { toolsRunning: {}, activity: { mods: [] } } as any;
    });
    const callbacks: Array<() => void> = [];
    const checks = new Map<string, () => Promise<any>>();
    const context: any = new Proxy(
      { api: h.api },
      {
        get: (obj, key) =>
          key in obj
            ? obj[key]
            : key === "once"
              ? (cb: () => void) => callbacks.push(cb)
              : key === "registerTest"
                ? (name: string, _event: string, cb: () => Promise<any>) => checks.set(name, cb)
                : () => undefined,
      },
    );
    init(context);
    callbacks.forEach((cb) => cb());
    const manager = observed.managers[0];
    expect(observed.managers).toHaveLength(1);
    const destination = path.join(path.dirname(h.stagingDir), "destination");
    fs.mkdirSync(destination);
    if (!["legacy", "empty-legacy"].includes(kind))
      expect(await prepareStagingTransfer(h.stagingDir, destination)).toBe(true);
    const victim = path.join(destination, "preserved.txt");
    if (kind !== "empty-legacy") fs.writeFileSync(victim, "destination bytes");
    if (kind === "malformed")
      fs.writeFileSync(path.join(destination, STAGING_TRANSFER_TAG), "null");
    const originalDestination = path.join(path.dirname(destination), "original-destination");
    if (kind === "replaced") {
      const marker = fs.readFileSync(path.join(destination, STAGING_TRANSFER_TAG));
      fs.renameSync(destination, originalDestination);
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, STAGING_TRANSFER_TAG), marker);
      fs.writeFileSync(victim, "destination bytes");
      expect(fs.statSync(destination).ino).not.toBe(fs.statSync(originalDestination).ino);
    }
    const preservedSource = path.join(path.dirname(h.stagingDir), "source-backup");
    if (kind === "missing-source") fs.renameSync(h.stagingDir, preservedSource);
    h.api.store.dispatch(setTransferMods(gameId, destination));
    const check = await checks.get("verify-mod-transfers")();
    expect(check.description.short).toBe("Folder transfer was interrupted");
    if (kind === "selected") h.api.store.dispatch(setInstallPath(gameId, destination));
    if (kind === "changed-marker")
      h.api.store.dispatch(setTransferMods(gameId, originalDestination));
    const nativeWork: PromiseLike<unknown>[] = [];
    const remove = nativeFs.removeAsync;
    vi.spyOn(nativeFs, "removeAsync").mockImplementation((...args) => {
      const operation = remove(...args);
      nativeWork.push(operation);
      void operation.catch(() => undefined);
      return operation;
    });
    let operation: PromiseLike<unknown>;
    try {
      if (kind === "cleanup-denied") fs.chmodSync(destination, 0);
      operation = check.automaticFix();
      if (kind === "cleanup-denied") {
        await expect(operation).rejects.toMatchObject({ code: "EACCES" });
        await Promise.allSettled(nativeWork);
        expect(h.getState().persistent.transactions.transfer[gameId]).toBe(destination);
        fs.chmodSync(destination, 0o700);
        expect(fs.readFileSync(victim, "utf8")).toBe("destination bytes");
        expect(fs.existsSync(path.join(destination, STAGING_TRANSFER_TAG))).toBe(true);
        operation = check.automaticFix();
      }
      await operation;
      let count = -1;
      while (count !== nativeWork.length) {
        count = nativeWork.length;
        await Promise.allSettled(nativeWork);
      }
      for (const limiter of [manager.mInstallLimit, manager.mDependencyPipelineLimit]) {
        await limiter.mEndOfQueue;
        expect(limiter.mNext).toBeUndefined();
        expect(limiter.mLimit).toBe(limiter.mInitialLimit);
      }
      for (const key of [
        "mActiveInstalls",
        "mPendingInstalls",
        "mRunningInstalls",
        "mDependencyAttempts",
      ])
        expect(manager[key].size).toBe(0);
      expect(h.getState().persistent.transactions.transfer[gameId]).toBe(
        kind === "changed-marker" ? originalDestination : undefined,
      );
      if (["private", "empty-legacy", "cleanup-denied"].includes(kind))
        expect(fs.existsSync(destination)).toBe(false);
      else
        expect(fs.existsSync(victim) ? fs.readFileSync(victim, "utf8") : null).toBe(
          "destination bytes",
        );
      const sourceRoot = kind === "missing-source" ? preservedSource : h.stagingDir;
      expect(fs.readFileSync(path.join(sourceRoot, "SomeMod/config.ini"), "utf8")).toBe(
        "source bytes",
      );
      if (kind === "replaced")
        expect(fs.readFileSync(path.join(originalDestination, "preserved.txt"), "utf8")).toBe(
          "destination bytes",
        );
    } finally {
      if (fs.existsSync(destination)) fs.chmodSync(destination, 0o700);
      if (operation) await Promise.allSettled([operation]);
      await Promise.allSettled(nativeWork);
      for (const limiter of [manager.mInstallLimit, manager.mDependencyPipelineLimit])
        await limiter.mEndOfQueue;
      h.api.events.removeAllListeners();
      await h.method.cancel(gameId, h.gameDir, h.stagingDir);
    }
  });
}
