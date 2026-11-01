import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import React from "react";
import { afterEach, expect, test, vi } from "vitest";

import { makeApiHarness, makeProfile } from "../../../test-utils/builders";
import type { IExtensionContext } from "../../../types/IExtensionContext";
import type { ITestResult } from "../../../types/ITestResult";
import * as native from "../../../util/fs";
import { getSafe } from "../../../util/storeHelper";
import { prepareStagingTransfer, STAGING_TRANSFER_TAG } from "../../../util/transferPath";
import { setDownloadPath } from "../actions/settings";
import { setTransferDownloads } from "../actions/transactions";
import init from "../index";
import { settingsReducer } from "../reducers/settings";
import { transactionsReducer } from "../reducers/transactions";
import { DOWNLOADS_DIR_TAG } from "../util/downloadDirectory";
import Settings from "./Settings";

vi.mock("../../../controls/ComponentEx", async (load) => ({
  ...(await load<object>()),
  connect: () => (component: unknown) => component,
  translate: () => (component: unknown) => component,
}));

afterEach(() => vi.restoreAllMocks());

function nodes(element: any): any[] {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray((element.props as any).children).flatMap(nodes)];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(source: string) {
  const profile = makeProfile({ id: "p", gameId: "game-a" });
  const h = makeApiHarness({ profiles: { p: profile }, activeProfileId: "p" }, [
    { path: ["settings", "downloads"], reducer: settingsReducer },
    { path: ["persistent", "transactions"], reducer: transactionsReducer },
  ]);
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "downloads-transfer" };
    state.settings.downloads.path = source;
  });
  vi.spyOn(h.api, "sendNotification");
  const dismissed = vi.spyOn(h.api, "dismissNotification");
  vi.spyOn(h.api, "showErrorNotification");
  const checks = new Map<string, () => PromiseLike<ITestResult>>();
  const context = new Proxy(
    { api: h.api },
    {
      get: (obj, key) =>
        key in obj
          ? obj[key]
          : key === "registerTest"
            ? (name: string, _event: string, callback: () => PromiseLike<ITestResult>) =>
                checks.set(name, callback)
            : () => undefined,
    },
  ) as unknown as IExtensionContext;
  expect(init(context)).toBe(true);
  return { ...h, dismissed, check: () => checks.get("verify-downloads-transfers")() };
}

function observeWork() {
  const work: PromiseLike<unknown>[] = [];
  const track = <T extends PromiseLike<unknown>>(operation: T): T => {
    work.push(operation);
    void Promise.resolve(operation).catch(() => undefined);
    return operation;
  };
  for (const key of [
    "linkAsync",
    "lstatAsync",
    "statAsync",
    "readdirAsync",
    "readFileAsync",
    "removeAsync",
    "writeFileAsync",
    "rmdirAsync",
    "ensureDirAsync",
  ] as const) {
    const original = native[key];
    vi.spyOn(native, key).mockImplementation((...args: any[]) => track((original as any)(...args)));
  }
  const copy = fs.promises.copyFile.bind(fs.promises);
  vi.spyOn(fs.promises, "copyFile").mockImplementation((...args) => track(copy(...args)));
  const drain = async () => {
    let count = -1;
    while (count !== work.length) {
      count = work.length;
      await Promise.allSettled(work);
    }
  };
  return { track, drain };
}

const bytes = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

for (const kind of [
  "empty",
  "new",
  "merge",
  "other-merge",
  "identical",
  "collision",
  "other-collision",
  "read-failure",
  "empty-failure",
  "tag-denied",
  "existing-tag-readonly",
  "source-cleanup-denied",
  "held-conflict",
  "cleanup-denied",
  "reinitialize",
  "cancel",
] as const) {
  test(`Downloads input and Apply retain transfer ownership: ${kind}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "downloads-settings-"));
    const source = path.join(root, "source");
    const dest = path.join(root, "destination");
    const from = path.join(source, "game-a/archive.zip");
    const to = path.join(dest, "game-a/archive.zip");
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.writeFileSync(from, "current archive");
    fs.writeFileSync(
      path.join(source, DOWNLOADS_DIR_TAG),
      JSON.stringify({ instance: "downloads-transfer" }),
    );
    if (kind !== "new") fs.mkdirSync(dest);
    const existing = [
      "merge",
      "other-merge",
      "identical",
      "collision",
      "other-collision",
      "read-failure",
      "existing-tag-readonly",
      "held-conflict",
    ].includes(kind);
    const conflict = ["collision", "other-collision", "held-conflict"].includes(kind);
    const denied = ["read-failure", "empty-failure", "cleanup-denied"].includes(kind);
    const failed = conflict || denied || kind === "tag-denied";
    const other = kind.startsWith("other-");
    const oldTag = JSON.stringify({
      instance: other ? "other-instance" : "downloads-transfer",
      retained: "exact bytes",
    });
    if (existing) {
      fs.writeFileSync(path.join(dest, DOWNLOADS_DIR_TAG), oldTag);
      fs.writeFileSync(path.join(dest, "unrelated.txt"), "preexisting unrelated");
      fs.mkdirSync(path.join(dest, "retained"));
      fs.writeFileSync(path.join(dest, "retained/binary"), Buffer.from([0, 255, 13, 10]));
      fs.symlinkSync("../unrelated.txt", path.join(dest, "retained/link"));
    }
    if (conflict || kind === "identical") {
      fs.mkdirSync(path.dirname(to));
      if (kind === "identical") fs.linkSync(from, to);
      else fs.writeFileSync(to, "existing archive");
      expect(fs.statSync(from).ino === fs.statSync(to).ino).toBe(kind === "identical");
    }
    if (kind === "held-conflict")
      fs.writeFileSync(path.join(source, "game-a/extra.zip"), "additional archive");
    if (kind === "existing-tag-readonly") fs.chmodSync(path.join(dest, DOWNLOADS_DIR_TAG), 0o400);
    if (kind === "reinitialize" || kind === "cancel") fs.rmSync(source, { recursive: true });
    const h = setup(source);
    const publishedRoots: string[] = [];
    h.api.onStateChange(["settings", "downloads", "path"], (_previous, current) =>
      publishedRoots.push(current),
    );
    const transfers = vi.fn((value: string) => {
      h.api.store.dispatch(setTransferDownloads(value));
      if (kind === "cleanup-denied" && value === dest) fs.chmodSync(dest, 0);
    });
    const errors = vi.fn();
    const dialogs = vi.fn(async (_type, _title, _content, actions) => {
      const label = kind === "reinitialize" ? "Reinitialize" : "Continue";
      const answer = actions.find((action) => action.label === label) ?? actions[0];
      await answer.action?.();
      return { action: answer.label, input: {} };
    });
    const willMove = vi.fn(() => {
      if (denied) fs.chmodSync(path.dirname(from), 0);
      if (kind === "tag-denied") fs.chmodSync(path.join(source, DOWNLOADS_DIR_TAG), 0o400);
    });
    const didMove = vi.fn();
    h.api.events.on("will-move-downloads", willMove);
    h.api.events.on("did-move-downloads", didMove);
    const work = observeWork();
    const admitted = deferred(),
      release = deferred(),
      collision = deferred();
    if (kind === "held-conflict") {
      const link = vi.mocked(native.linkAsync).getMockImplementation();
      vi.mocked(native.linkAsync).mockImplementation((...args) => {
        if (args[0].endsWith("/extra.zip")) {
          admitted.resolve();
          return work.track(PromiseBB.resolve(release.promise).then(() => link(...args)));
        }
        const operation = link(...args);
        void operation.catch((error) => {
          if (error.code === "EEXIST") collision.resolve();
        });
        return operation;
      });
    }
    const sourceCleanup = vi.fn();
    const remove = vi.mocked(native.removeAsync).getMockImplementation();
    vi.mocked(native.removeAsync).mockImplementation((...args) => {
      if (args[0] === source) {
        sourceCleanup(fs.existsSync(path.join(dest, STAGING_TRANSFER_TAG)));
        if (kind === "source-cleanup-denied") fs.chmodSync(source, 0);
      }
      return remove(...args);
    });
    const ui: any = new (Settings as any)({
      downloadPath: source,
      modsInstallPath: path.join(root, "unused-mods"),
      downloads: {},
      instanceId: "downloads-transfer",
      isPremium: true,
      parallelDownloads: 1,
      copyOnIFF: false,
      maxBandwidth: 0,
      collectionsInstallWhileDownloading: false,
      t: (value) => value,
      onSetTransfer: transfers,
      onShowError: errors,
      onShowDialog: dialogs,
    });
    ui.setState = (value) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    const input = nodes(ui.render()).find(
      (node) => node.props?.className === "download-path-input",
    );
    input.props.onChange({ currentTarget: { value: dest } });
    const apply = nodes(ui.render()).find(
      (node) => node.props?.children === "Apply" && node.props?.onClick,
    );
    expect(apply.props.disabled).toBe(false);
    const terminal = vi.fn();
    const operation = Promise.resolve(apply.props.onClick()).then(() => terminal());
    let boundary: unknown, earlyCalls: number;
    const restore = () => {
      for (const folder of [source, path.dirname(from), dest])
        if (fs.existsSync(folder)) fs.chmodSync(folder, 0o700);
    };
    try {
      if (kind === "held-conflict") {
        await admitted.promise;
        boundary = await Promise.race([
          collision.promise.then(() => "native-collision"),
          operation.then(() => "public"),
        ]);
        earlyCalls = terminal.mock.calls.length;
        release.resolve();
      }
      await operation;
      await work.drain();
      restore();
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(willMove).toHaveBeenCalledTimes(1);
      expect(dialogs).toHaveBeenCalledTimes(
        other || ["source-cleanup-denied", "reinitialize", "cancel"].includes(kind) ? 1 : 0,
      );
      expect(ui.state.busy).toBeUndefined();
      if (kind === "held-conflict") {
        expect.soft(boundary).toBe("native-collision");
        expect.soft(earlyCalls).toBe(0);
        expect(bytes(path.join(dest, "game-a/extra.zip"))).toBe("additional archive");
      }
      if (failed || kind === "cancel") {
        expect(publishedRoots).toEqual([]);
        expect(didMove).toHaveBeenCalledTimes(0);
        expect(h.getState().settings.downloads.path).toBe(source);
        expect(errors).toHaveBeenCalledTimes(
          kind === "cancel" ? 0 : kind === "cleanup-denied" ? 2 : 1,
        );
        if (failed)
          expect(errors.mock.calls[0][1]).toMatchObject({ code: conflict ? "EEXIST" : "EACCES" });
        if (kind !== "cancel") expect.soft(bytes(from)).toBe("current archive");
        expect(sourceCleanup).toHaveBeenCalledTimes(0);
        if (conflict) expect.soft(bytes(to)).toBe("existing archive");
        if (!existing)
          expect(fs.existsSync(dest)).toBe(kind === "cleanup-denied" || kind === "cancel");
      } else {
        expect(publishedRoots).toEqual([dest]);
        expect(errors).toHaveBeenCalledTimes(0);
        expect(didMove).toHaveBeenCalledTimes(1);
        expect(h.getState().settings.downloads.path).toBe(dest);
        expect(sourceCleanup.mock.calls).toEqual(kind === "reinitialize" ? [] : [[false]]);
        expect(fs.existsSync(source)).toBe(kind === "source-cleanup-denied");
        if (kind !== "reinitialize") expect(bytes(to)).toBe("current archive");
        if (kind === "source-cleanup-denied") {
          expect(bytes(from)).toBe("current archive");
          expect(h.api.showErrorNotification).toHaveBeenCalledExactlyOnceWith(
            "Clean-up failed",
            expect.objectContaining({ code: "EACCES" }),
          );
        }
      }
      expect(h.api.showErrorNotification).toHaveBeenCalledTimes(
        kind === "source-cleanup-denied" ? 1 : 0,
      );
      if (kind === "cancel")
        expect(fs.existsSync(path.join(dest, STAGING_TRANSFER_TAG))).toBe(false);
      if (existing) {
        expect.soft(bytes(path.join(dest, "unrelated.txt"))).toBe("preexisting unrelated");
        expect.soft(bytes(path.join(dest, DOWNLOADS_DIR_TAG))).toBe(oldTag);
        expect
          .soft(
            fs.existsSync(path.join(dest, "retained/binary"))
              ? fs.readFileSync(path.join(dest, "retained/binary"))
              : null,
          )
          .toEqual(Buffer.from([0, 255, 13, 10]));
        expect
          .soft(
            fs.existsSync(path.join(dest, "retained/link"))
              ? fs.readlinkSync(path.join(dest, "retained/link"))
              : null,
          )
          .toBe("../unrelated.txt");
      }
      expect(
        getSafe(h.getState(), ["persistent", "transactions", "transfer", "downloads"], undefined),
      ).toBe(kind === "cleanup-denied" ? dest : undefined);
      expect(transfers.mock.calls).toEqual(
        kind === "cancel" ? [] : kind === "cleanup-denied" ? [[dest]] : [[dest], [undefined]],
      );
      if (kind === "cleanup-denied") {
        expect(fs.existsSync(path.join(dest, STAGING_TRANSFER_TAG))).toBe(true);
        const recovery = await h.check();
        await recovery.automaticFix();
        await work.drain();
        expect(
          getSafe(h.getState(), ["persistent", "transactions", "transfer", "downloads"], undefined),
        ).toBeUndefined();
        expect(fs.existsSync(dest)).toBe(false);
        expect(bytes(from)).toBe("current archive");
      }
    } finally {
      release.resolve();
      restore();
      await operation;
      await work.drain();
      h.api.events.removeAllListeners();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const kind of [
  "private",
  "legacy",
  "empty",
  "malformed",
  "replaced",
  "selected",
  "missing-source",
  "denied",
  "changed-marker",
  "changed-during-cleanup",
  "no-game",
] as const) {
  test(`registered Downloads recovery preserves unowned bytes: ${kind}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "downloads-recovery-"));
    const source = path.join(root, "source"),
      dest = path.join(root, "destination");
    fs.mkdirSync(source);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(source, "archive.zip"), "source archive");
    const h = setup(source);
    const owned = !["legacy", "empty", "no-game"].includes(kind);
    if (owned) expect(await prepareStagingTransfer(source, dest)).toBe(true);
    const victim = path.join(dest, "preserved.zip");
    if (kind !== "empty") fs.writeFileSync(victim, "destination archive");
    if (kind === "malformed") fs.writeFileSync(path.join(dest, STAGING_TRANSFER_TAG), "null");
    const backup = path.join(root, "original-destination");
    if (kind === "replaced") {
      const tag = fs.readFileSync(path.join(dest, STAGING_TRANSFER_TAG));
      fs.renameSync(dest, backup);
      fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, STAGING_TRANSFER_TAG), tag);
      fs.writeFileSync(victim, "destination archive");
      expect(fs.statSync(dest).ino).not.toBe(fs.statSync(backup).ino);
    }
    if (kind === "missing-source") fs.renameSync(source, path.join(root, "source-backup"));
    h.api.store.dispatch(setTransferDownloads(dest));
    if (kind === "no-game")
      h.setState((state) => {
        state.settings.profiles.activeProfileId = undefined;
      });
    const result = await h.check();
    expect(result.description.short).toBe("Folder transfer was interrupted");
    if (kind === "selected") h.api.store.dispatch(setDownloadPath(dest));
    if (kind === "changed-marker") h.api.store.dispatch(setTransferDownloads(backup));
    const work = observeWork();
    if (kind === "changed-during-cleanup") {
      const remove = vi.mocked(native.removeAsync).getMockImplementation();
      vi.mocked(native.removeAsync).mockImplementation((...args) => {
        h.api.store.dispatch(setTransferDownloads(backup));
        return remove(...args);
      });
    }
    let operation: PromiseLike<unknown>;
    try {
      if (kind === "denied") fs.chmodSync(dest, 0);
      operation = result.automaticFix();
      if (kind === "denied") {
        await expect(operation).rejects.toMatchObject({ code: "EACCES" });
        await work.drain();
        expect(
          getSafe(h.getState(), ["persistent", "transactions", "transfer", "downloads"], undefined),
        ).toBe(dest);
        fs.chmodSync(dest, 0o700);
        expect(bytes(victim)).toBe("destination archive");
        expect(fs.existsSync(path.join(dest, STAGING_TRANSFER_TAG))).toBe(true);
        operation = result.automaticFix();
      }
      await operation;
      await work.drain();
      const changed = kind === "changed-marker" || kind === "changed-during-cleanup";
      expect(
        getSafe(h.getState(), ["persistent", "transactions", "transfer", "downloads"], undefined),
      ).toBe(changed ? backup : undefined);
      const removed = ["private", "empty", "denied", "changed-during-cleanup"].includes(kind);
      if (removed) expect(fs.existsSync(dest)).toBe(false);
      else expect.soft(bytes(victim)).toBe("destination archive");
      const original = kind === "missing-source" ? path.join(root, "source-backup") : source;
      expect(bytes(path.join(original, "archive.zip"))).toBe("source archive");
      if (kind === "replaced")
        expect(bytes(path.join(backup, "preserved.zip"))).toBe("destination archive");
      const count = kind === "changed-marker" ? 0 : kind === "denied" ? 2 : 1;
      expect(h.api.sendNotification).toHaveBeenCalledTimes(count);
      expect(h.dismissed.mock.calls).toEqual(
        Array.from({ length: count }, () => ["transfer-cleanup"]),
      );
      expect(h.api.showErrorNotification).toHaveBeenCalledTimes(0);
      expect(await h.check()).toEqual(
        changed ? expect.objectContaining({ severity: "warning" }) : undefined,
      );
    } finally {
      if (fs.existsSync(dest)) fs.chmodSync(dest, 0o700);
      if (operation) await Promise.allSettled([operation]);
      await work.drain();
      h.api.events.removeAllListeners();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
