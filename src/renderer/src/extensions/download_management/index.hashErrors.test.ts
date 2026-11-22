import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { deserializeVortexError, toWireError } from "@vortex/shared/errors";
import PromiseBB from "bluebird";
import { expect, it, vi } from "vitest";

import { downloadsReducer } from "../../reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import * as fs from "../../util/fs";
import { walkPath } from "../collections/util/walk";
import init from "./index";

vi.mock("./views/DownloadView", () => ({ default: () => null }));
vi.mock("./views/Settings", () => ({ default: () => null }));
vi.mock("./views/ShutdownButton", () => ({ default: () => null }));
vi.mock("./views/SpeedOMeter", () => ({ default: () => null }));
vi.mock("./downloadAttributes", () => ({ default: () => [] }));
vi.mock("./util/downloadDirectory", () => ({
  ensureDownloadsDirectory: () => PromiseBB.resolve(),
}));
vi.mock("turbowalk", () => ({
  default: async (directory, callback) =>
    callback([{ filePath: path.join(directory, "archive.zip") }]),
}));

function transportedError(code: string, file: string) {
  return deserializeVortexError(
    structuredClone(
      toWireError(
        Object.assign(new Error("read failed"), {
          code,
          errno: -2,
          syscall: "open",
          path: file,
        }),
      ),
    ),
  );
}

it.each(["ENOENT", "EACCES"])(
  "repairs rehydrated downloads and handles collection hash failures: %s",
  async (code) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nyastra-hash-callers-"));
    const previousApi = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const compute = vi.fn(async (_algorithm: string, file: string) => {
        throw transportedError(code, file);
      });
      window.api = { ...previousApi, hash: { compute } };
      const profile = makeProfile({ id: "profile", gameId: "game" });
      const download = makeDownload({
        id: "archive",
        game: ["game"],
        state: "finished",
        localPath: "archive.zip",
        fileMD5: undefined,
      });
      const h = makeApiHarness(
        {
          downloads: JSON.parse(JSON.stringify({ archive: download })),
          profiles: { profile },
          activeProfileId: profile.id,
        },
        [{ path: ["persistent", "downloads"], reducer: downloadsReducer }],
      );
      h.setState((state) => {
        state.settings.downloads.path = root;
        state.session.base = { commandLine: {} } as never;
      });
      vi.spyOn(fs, "watch").mockReturnValue({
        close: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.FSWatcher);
      h.api.registerProtocol = vi.fn();
      h.api.deregisterProtocol = vi.fn();
      const callbacks: Array<() => void> = [];
      const context = new Proxy(
        { api: h.api, once: (callback: () => void) => callbacks.push(callback) },
        {
          get: (target, key) => (key in target ? target[key] : () => undefined),
        },
      ) as any;
      init(context);
      callbacks.splice(0).forEach((callback) => callback());
      const repair = h.notifications.find(
        (notification) => notification.title === "Some downloads were not finalized",
      );
      expect(repair?.actions).toHaveLength(1);
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.api.dismissNotification = () => finish();
      repair.actions[0].action(() => undefined);
      await finished;
      expect(compute).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(JSON.stringify(h.getState().persistent.downloads.files));
      expect(saved.archive).toEqual(code === "ENOENT" ? undefined : download);

      if (code === "ENOENT") {
        await expect(walkPath(root)).resolves.toEqual([]);
      } else {
        await expect(walkPath(root)).rejects.toMatchObject({
          data: { kind: "fs:no-permissions", originalCode: code },
        });
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      window.api = previousApi;
      await rm(root, { recursive: true, force: true });
    }
  },
);
