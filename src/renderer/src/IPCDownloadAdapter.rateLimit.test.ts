import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as nodeUtil from "node:util";

import {
  HTTPError as SDKHTTPError,
  NexusError,
  RateLimitError,
  TimeoutError,
} from "@nexusmods/nexus-api";
import { AlreadyDownloaded } from "@vortex/shared/errors";
import Bluebird from "bluebird";
import { expect, it, vi } from "vitest";

import { NxmProtocol } from "./extensions/nexus_integration/nxmProtocol";
import { isRateLimited, notifyRateLimited } from "./extensions/nexus_integration/rateLimit";
import type * as util from "./extensions/nexus_integration/util";
import { IPCDownloadAdapter } from "./IPCDownloadAdapter";
import { makeNxmHarness, makeUserInfo } from "./test-utils/builders";
import * as errors from "./util/CustomErrors";
import { contextify } from "./util/errorHandling";
import { getSafe } from "./util/storeHelper";
const bus = vi.hoisted(() => ({
  handlers: new Map(),
  main: undefined as any,
  renderer: undefined as any,
  sender: undefined as any,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  bus.main = new EventEmitter();
  bus.renderer = new EventEmitter();
  bus.main.handle = (channel: string, fn: unknown) => bus.handlers.set(channel, fn);
  bus.renderer.invoke = async (channel: string, ...args: unknown[]) =>
    structuredClone(
      await bus.handlers.get(channel)(
        { sender: bus.sender, senderFrame: { url: "file:///review/index.html" } },
        ...structuredClone(args),
      ),
    );
  bus.renderer.send = (channel: string, ...args: unknown[]) =>
    queueMicrotask(() =>
      bus.main.emit(
        channel,
        { sender: bus.sender, senderFrame: { url: "file:///review/index.html" } },
        ...structuredClone(args),
      ),
    );
  return { ipcMain: bus.main, ipcRenderer: bus.renderer };
});
vi.mock("../../main/src/logging", () => ({ log: vi.fn() }));
vi.mock("./extensions/nexus_integration/util", async (original) => ({
  ...(await original<typeof util>()),
  ensureLoggedIn: vi.fn(() => Promise.resolve()),
  getInfoGraphQL: vi.fn(async () => ({ modInfo: {}, fileInfo: { name: "archive.zip" } })),
}));

const cases = [
  ["RateLimitError", () => new RateLimitError(), true],
  [
    "SDK HTTP 429",
    () => new SDKHTTPError(429, "Too Many Requests", "", "https://example.invalid"),
    true,
  ],
  [
    "SDK Nexus 429",
    () => new NexusError("Too Many Requests", 429, "https://example.invalid", ""),
    true,
  ],
  [
    "shared HTTP 429",
    () => new errors.HTTPError(429, "Too Many Requests", "https://example.invalid"),
    true,
  ],
  ["UserCanceled", () => new errors.UserCanceled(true), false],
  [
    "SDK HTTP 500",
    () => new SDKHTTPError(500, "Server Error", "", "https://example.invalid"),
    false,
  ],
  ["unclassified message", () => new Error("rate limit"), false],
] as const;

it.each(cases)(
  "public download consumer keeps callback semantics: %s",
  async (_name, makeError, limited) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nyastra-callback-rate-limit-"));
    const previous = window.api;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const h = makeNxmHarness({ userInfo: makeUserInfo({ isPremium: true }) });
    h.setState((state) => {
      state.settings.downloads.path = root;
    });
    const original = makeError();
    h.getDownloadURLs.mockRejectedValue(original);
    bus.sender = Object.assign(new EventEmitter(), {
      id: 7,
      send: (channel: string, ...args: unknown[]) =>
        queueMicrotask(() => bus.renderer.emit(channel, {}, ...structuredClone(args))),
    });
    const preload = await import(path.resolve(__dirname, "../../preload/src/ipc.ts"));
    const main = await import(path.resolve(__dirname, "../../main/src/downloading/ipc.ts"));
    const manager = {
      download: vi.fn(() => {
        throw new Error("Resolver failure must prevent admission");
      }),
    };
    main.init(manager as any);
    let unsubscribe: (() => void) | undefined;
    window.api = {
      ...previous,
      downloader: {
        onResolve: (handler) => {
          unsubscribe = preload.rendererCallback("download:resolve", handler);
          return unsubscribe;
        },
        start: (...args) => preload.rendererInvoke("download:start", ...args),
      },
    } as any;
    try {
      const adapter = new IPCDownloadAdapter(h.api);
      const nxm = new NxmProtocol(h.api, () => h.nexus);
      nxm.start();
      adapter.registerProtocol("nxm", nxm.resolve);
      let callbackError: unknown;
      const api = {
        ...h.api,
        events: {
          emit: (event, urls, info, name, callback, ...rest) =>
            h.api.events.emit(
              event,
              urls,
              info,
              name,
              (error, ...result) => {
                callbackError = error;
                callback(error, ...result);
              },
              ...rest,
            ),
        },
      };
      const start = loadStartDownloadMod();
      const result = await start(api, h.nexus, "nxm://skyrimspecialedition/mods/100/files/500", {
        gameId: "skyrimspecialedition",
        modId: 100,
        fileId: 500,
      });
      expect(result).toBeNull();
      expect(manager.download).not.toHaveBeenCalled();
      expect(isRateLimited(callbackError)).toBe(limited);
      if (limited) {
        expect(h.errorNotifications).toHaveLength(0);
        expect(h.notifications.length).toBeGreaterThan(0);
        expect(new Set(h.notifications.map((n) => n.id))).toEqual(new Set(["nexus-rate-limited"]));
        expect(h.notifications.every((n) => n.type === "warning")).toBe(true);
      } else if (original instanceof errors.UserCanceled) {
        expect(callbackError).toBe(original);
        expect((callbackError as errors.UserCanceled).skipped).toBe(true);
        expect(h.errorNotifications).toHaveLength(0);
      } else {
        expect(h.errorNotifications).toHaveLength(1);
        expect(h.errorNotifications[0].title).toBe("Download failed");
      }
      expect(bus.main.listenerCount("callback:download:resolve")).toBe(0);
      for (const event of ["destroyed", "render-process-gone", "did-start-navigation"])
        expect(bus.sender.listenerCount(event)).toBe(0);
    } finally {
      unsubscribe?.();
      expect(bus.renderer.listenerCount("download:resolve")).toBe(0);
      bus.handlers.clear();
      vi.clearAllTimers();
      vi.useRealTimers();
      window.api = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

function loadStartDownloadMod() {
  const require = createRequire(path.resolve(__dirname, "../package.json"));
  const babel = require("@babel/core");
  const filename = path.join(__dirname, "extensions/nexus_integration/util.ts");
  const source = readFileSync(filename, "utf8");
  const parsed = babel.parseSync(source, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] },
  });
  const statements = parsed.program.body.filter(
    (node) =>
      (node.type === "FunctionDeclaration" && node.id?.name === "startDownloadMod") ||
      (node.type === "VariableDeclaration" &&
        node.declarations.some((item) => item.id?.name === "IGNORE_ERRORS")),
  );
  expect(statements).toHaveLength(2);
  const code = babel.transformSync(
    statements.map((node) => source.slice(node.start, node.end)).join("\n"),
    { filename, configFile: false, babelrc: false, presets: [require("@babel/preset-typescript")] },
  ).code;
  const bindings = {
    ...errors,
    AlreadyDownloaded,
    NexusError,
    TimeoutError,
    isRateLimited,
    notifyRateLimited,
    contextify,
    getSafe,
    BluebirdPromise: Bluebird,
    truthy: Boolean,
    log: () => {},
    util: nodeUtil,
    knownGames: () => [],
    convertNXMIdReverse: () => "skyrimse",
    nxmPageId: () => "skyrimspecialedition",
    getInfoGraphQL: () => Bluebird.resolve({ modInfo: {}, fileInfo: { name: "archive.zip" } }),
  };
  // Metadata is controlled. The production consumer and its catch logic run unchanged.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(
    ...Object.keys(bindings),
    code + "\nreturn startDownloadMod;",
  )(...Object.values(bindings));
}
