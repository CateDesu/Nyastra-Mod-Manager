import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import React from "react";
import { expect, test, vi } from "vitest";

import { makeApiHarness, makeProfile } from "../../test-utils/builders";
import { UserCanceled } from "../../util/CustomErrors";
import * as programFs from "../../util/fs";
import { setTransferDownloads } from "./actions/transactions";
import init from "./index";
import { settingsReducer } from "./reducers/settings";
import { transactionsReducer } from "./reducers/transactions";
import { DOWNLOADS_DIR_TAG } from "./util/downloadDirectory";
import Settings from "./views/Settings";
vi.mock("../../controls/ComponentEx", async (load) => ({
  ...(await load<object>()),
  connect: () => (value) => value,
  translate: () => (value) => value,
}));
vi.mock("./util/queryDLInfo", () => ({ default: () => Bluebird.resolve() }));
function nodes(element: any): any[] {
  return React.isValidElement(element)
    ? [element, ...React.Children.toArray((element.props as any).children).flatMap(nodes)]
    : [];
}
for (const outcome of [
  "collision",
  "permission",
  "cancel",
  "rollback-denied",
  "success",
  "cleanup-failed",
  "game-switch",
  "newer-move",
  "background-refresh",
] as const) {
  test(`Downloads watching follows the live root after ${outcome}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-transfer-"));
    const oldRoot = path.join(root, "old"),
      newRoot = path.join(root, "new");
    const game = "proof-game";
    for (const dir of [oldRoot, newRoot]) {
      fs.mkdirSync(path.join(dir, game), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DOWNLOADS_DIR_TAG),
        JSON.stringify({ instance: "watch-proof" }),
      );
    }
    const payload = path.join(root, "payload.txt");
    fs.writeFileSync(payload, "native synthetic archive");
    const archive = path.join(root, "payload.zip");
    await new Zip().add(archive, [payload]);
    const bytes = fs.readFileSync(archive);
    fs.copyFileSync(archive, path.join(oldRoot, game, "collision.zip"));
    if (outcome === "collision")
      fs.writeFileSync(path.join(newRoot, game, "collision.zip"), "preexisting unrelated bytes");
    const h = makeApiHarness(
      {
        profiles: {
          p: makeProfile({ id: "p", gameId: game }),
          other: makeProfile({ id: "other", gameId: "other-game" }),
        },
        activeProfileId: "p",
      },
      [
        { path: ["settings", "downloads"], reducer: settingsReducer },
        { path: ["persistent", "transactions"], reducer: transactionsReducer },
      ],
    );
    h.setState((s) => {
      s.app = { ...s.app, instanceId: "watch-proof" };
      s.settings.downloads.path = oldRoot;
      s.session.base = { commandLine: {} } as any;
    });
    h.api.registerProtocol = vi.fn();
    h.api.deregisterProtocol = vi.fn();
    h.api.lookupModMeta = vi.fn().mockResolvedValue([]);
    const once: (() => void)[] = [];
    const context: any = new Proxy(
      { api: h.api, once: (cb) => once.push(cb) },
      { get: (target, key) => (key in target ? target[key] : () => undefined) },
    );
    const open = new Set<fs.FSWatcher>();
    const created: string[] = [];
    const nativeWatch = programFs.watch;
    vi.spyOn(programFs, "watch").mockImplementation(((...args) => {
      const watcher = nativeWatch(...args);
      open.add(watcher);
      created.push(String(args[0]));
      watcher.once("close", () => open.delete(watcher));
      return watcher;
    }) as typeof programFs.watch);
    init(context);
    once.forEach((cb) => cb());
    const refresh = () =>
      new Promise<void>((resolve, reject) =>
        h.api.events.emit("refresh-downloads", game, (err) => (err ? reject(err) : resolve())),
      );
    const names = () =>
      Object.values(h.getState().persistent.downloads.files).map((d) => d.localPath);
    const errors = vi.fn();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.api.events.on("will-move-downloads", () => {
      if (outcome === "permission") fs.chmodSync(path.join(oldRoot, game), 0);
    });
    const remove = programFs.removeAsync;
    if (["cleanup-failed", "game-switch", "newer-move"].includes(outcome))
      vi.spyOn(programFs, "removeAsync").mockImplementation((target, ...args) => {
        if (target !== oldRoot) return remove(target, ...args);
        if (outcome === "cleanup-failed") {
          fs.chmodSync(oldRoot, 0);
          return remove(target, ...args);
        }
        entered();
        return Bluebird.resolve(gate).then(() => remove(target, ...args));
      });
    if (outcome === "rollback-denied") {
      fs.rmSync(newRoot, { recursive: true });
      const link = programFs.linkAsync;
      vi.spyOn(programFs, "linkAsync").mockImplementation((from, ...args) => {
        if (from.endsWith("collision.zip")) {
          fs.chmodSync(newRoot, 0);
          return Bluebird.reject(new UserCanceled());
        }
        return link(from, ...args);
      });
    }
    if (outcome === "cancel")
      vi.spyOn(programFs, "linkAsync").mockRejectedValue(new UserCanceled());
    const ui: any = new (Settings as any)({
      downloadPath: oldRoot,
      downloads: h.getState().persistent.downloads.files,
      modsInstallPath: path.join(root, "unused"),
      instanceId: "watch-proof",
      t: (s) => s,
      isPremium: true,
      parallelDownloads: 1,
      copyOnIFF: false,
      maxBandwidth: 0,
      onSetTransfer: (value) => h.api.store.dispatch(setTransferDownloads(value)),
      onShowError: errors,
      onShowDialog: async () => ({ action: "Continue" }),
    });
    ui.setState = (value) => {
      ui.state = { ...ui.state, ...value };
    };
    ui.context = { api: h.api };
    let moving: PromiseLike<unknown> | undefined;
    let newer: PromiseLike<unknown> | undefined;
    const newest = path.join(root, "newest");
    try {
      await refresh();
      if (outcome === "background-refresh") {
        fs.mkdirSync(path.join(oldRoot, "other-game"));
        await new Promise<void>((resolve, reject) =>
          h.api.events.emit("refresh-downloads", "other-game", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      }
      expect(open.size).toBe(1);
      expect(names()).toEqual(["collision.zip"]);
      const observedBaseline = new Promise<void>((resolve) => {
        const stop = h.api.store.subscribe(() => {
          if (names().includes("baseline.zip")) {
            stop();
            resolve();
          }
        });
      });
      fs.copyFileSync(archive, path.join(oldRoot, game, "baseline.zip"));
      await observedBaseline;
      expect(names()).toContain("baseline.zip");
      ui.props.downloads = h.getState().persistent.downloads.files;
      ui.setDownloadPath(newRoot);
      const apply = nodes(ui.render()).find(
        (x) => x.props?.children === "Apply" && x.props?.onClick,
      );
      expect(apply.props.disabled).toBe(false);
      moving = apply.props.onClick();
      let selectedGame = game;
      if (outcome === "game-switch" || outcome === "newer-move") {
        await held;
        if (outcome === "game-switch") {
          selectedGame = "other-game";
          fs.mkdirSync(path.join(oldRoot, selectedGame), { recursive: true });
          h.setState((s) => {
            s.settings.profiles.activeProfileId = "other";
          });
          h.api.events.emit("gamemode-activated", selectedGame);
        } else {
          ui.props.downloadPath = newRoot;
          ui.setDownloadPath(newest);
          newer = ui.onApply();
        }
        release();
      }
      await moving;
      if (newer) await newer;
      if (fs.existsSync(oldRoot)) fs.chmodSync(oldRoot, 0o700);
      if (fs.existsSync(path.join(oldRoot, game))) fs.chmodSync(path.join(oldRoot, game), 0o700);
      if (fs.existsSync(newRoot)) fs.chmodSync(newRoot, 0o700);
      const succeeded = [
        "success",
        "cleanup-failed",
        "game-switch",
        "newer-move",
        "background-refresh",
      ].includes(outcome);
      const selectedRoot = outcome === "newer-move" ? newest : succeeded ? newRoot : oldRoot;
      expect(h.getState().settings.downloads.path).toBe(selectedRoot);
      if (outcome === "collision") {
        expect(errors.mock.calls[0][1].code).toBe("EEXIST");
        expect(fs.readFileSync(path.join(newRoot, game, "collision.zip"), "utf8")).toBe(
          "preexisting unrelated bytes",
        );
      }
      await vi.waitFor(
        () => {
          expect(open.size).toBe(1);
          expect(created.at(-1)).toBe(path.join(selectedRoot, selectedGame));
        },
        { timeout: 5000 },
      );
      expect(created).toHaveLength(2);
      const later = path.join(selectedRoot, selectedGame, "later.zip");
      fs.copyFileSync(archive, later);
      await vi.waitFor(() => expect(names()).toContain("later.zip"), { timeout: 5000 });
      expect(fs.readFileSync(later)).toEqual(bytes);
      fs.unlinkSync(later);
      await vi.waitFor(() => expect(names()).not.toContain("later.zip"), { timeout: 5000 });
      expect(open.size).toBe(1);
    } finally {
      release();
      await Promise.allSettled([moving, newer]);
      h.api.events.emit("will-move-downloads");
      for (const folder of [oldRoot, path.join(oldRoot, game), newRoot])
        if (fs.existsSync(folder)) fs.chmodSync(folder, 0o700);
      for (const watcher of open) watcher.close();
      h.api.events.removeAllListeners();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
