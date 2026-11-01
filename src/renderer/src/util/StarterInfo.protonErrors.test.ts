import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { makeApiHarness, resetHarnessRegistries } from "../test-utils/builders";
import type { IExtensionApi } from "../types/IExtensionContext";
import { ProcessCanceled, UserCanceled } from "./CustomErrors";
import * as launchAnalytics from "./gameLaunchAnalytics";
import { Steam, type ISteamEntry } from "./Steam";

const catalog = vi.hoisted(() => ({
  allGames: vi.fn<() => Promise<ISteamEntry[]>>(),
  runToolWithProton: vi.fn<Steam["runToolWithProton"]>(),
}));
vi.mock("../extensions/gamemode_management/util/getGame", () => ({
  getGame: () => ({ id: "selected" }),
  getGameStoresSafe: () => [{ id: "steam", ...catalog }],
}));
vi.mock("./linux/steamPaths", () => ({
  findLinuxSteamPath: () => undefined,
  findAllLinuxSteamPaths: () => [],
}));
vi.mock("./gameLaunchAnalytics", () => ({
  emitGameLaunched: vi.fn<(api: IExtensionApi, info: IStarterInfo) => void>(),
  recordLaunchExit: vi.fn<(executable: string, code: number | null) => void>(),
}));

import StarterInfo, { type IStarterInfo } from "./StarterInfo";

let root: string;
let nativeWork: Bluebird<void>[];
let previousWindow: typeof window.api.window;

beforeEach(async () => {
  await import("../extensions/mod_management/index.js");
  expect(globalThis.Promise).toBe(Bluebird);
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-proton-errors-"));
  nativeWork = [];
  previousWindow = window.api.window;
  catalog.allGames.mockReset();
  catalog.runToolWithProton.mockReset();
  const store = new Steam();
  catalog.runToolWithProton.mockImplementation((...args) => store.runToolWithProton(...args));
});

afterEach(async () => {
  try {
    await Promise.all(
      nativeWork.map((operation) =>
        operation.then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
  } finally {
    window.api.window = previousWindow;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetHarnessRegistries();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(proton: boolean) {
  const gamePath = path.join(root, "Game");
  await mkdir(gamePath);
  const executable = path.join(gamePath, "mod-tool.exe");
  const bytes = Buffer.from("local launch fixture");
  await writeFile(executable, bytes);
  const entry: ISteamEntry = {
    gamePath,
    appid: "22",
    name: "Game",
    gameStoreId: "steam",
    usesProton: proton,
    protonPath: path.join(root, "Proton"),
    compatDataPath: path.join(root, "compatdata"),
    steamRoot: path.join(root, "steam"),
  };
  catalog.allGames.mockResolvedValue([entry]);
  const runExecutable = vi.fn<IExtensionApi["runExecutable"]>(() => Bluebird.resolve());
  const { api } = makeApiHarness();
  api.runExecutable = runExecutable;
  const dispatched = vi.spyOn(api.store, "dispatch");
  const info = new StarterInfo(
    { id: "selected", name: "Game", executable: "game.exe", requiredFiles: [] },
    { path: gamePath, store: "steam" },
    undefined,
    {
      id: "tool",
      name: "Tool",
      path: executable,
      hidden: false,
      custom: true,
      executable: () => "mod-tool.exe",
      requiredFiles: [],
      parameters: ["--target", "two words"],
      environment: { TOOL_MODE: "test" },
      shell: false,
      detach: false,
    },
  );
  const onShowError = vi.fn<(message: string, details?: unknown, allowReport?: boolean) => void>();
  return { info, api, runExecutable, onShowError, dispatched, bytes };
}

for (const proton of [false, true]) {
  for (const result of ["success", "ENOENT", "cancel", "process-cancel"] as const) {
    it(`handles ${result} with Proton=${proton}`, async () => {
      const f = await fixture(proton);
      const failure =
        result === "cancel"
          ? new UserCanceled()
          : result === "process-cancel"
            ? new ProcessCanceled("local cancellation")
            : Object.assign(new Error("missing executable"), { code: "ENOENT" });
      const originals: Bluebird<void>[] = [];
      f.runExecutable.mockImplementation((_exe, _args, options) => {
        if (result === "success") options.onSpawned?.();
        const original = result === "success" ? Bluebird.resolve() : Bluebird.reject(failure);
        originals.push(original);
        return original;
      });
      const completed = vi.fn<() => void>();
      const outcome = await StarterInfo.run(f.info, f.api, f.onShowError).then(
        () => {
          completed();
          return { error: undefined };
        },
        (error: unknown) => {
          completed();
          return { error };
        },
      );
      const settled = await Promise.all(
        originals.map((operation) =>
          operation.then(
            () => undefined,
            (error: unknown) => error,
          ),
        ),
      );
      expect(settled).toEqual(result === "success" ? [undefined] : [failure]);
      expect(f.runExecutable).toHaveBeenCalledTimes(1);
      expect(catalog.runToolWithProton).toHaveBeenCalledTimes(proton ? 1 : 0);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(outcome.error).toBeUndefined();
      expect(f.dispatched).toHaveBeenCalledTimes(result === "success" && !proton ? 1 : 0);
      expect(launchAnalytics.emitGameLaunched).toHaveBeenCalledTimes(
        result === "success" && !proton ? 1 : 0,
      );
      expect(f.onShowError).toHaveBeenCalledTimes(result === "ENOENT" ? 1 : 0);
      const [executable, args, options] = f.runExecutable.mock.calls[0];
      expect(executable).toBe(proton ? path.join(root, "Proton", "proton") : f.info.exePath);
      expect(args).toEqual(
        proton ? ["run", f.info.exePath, ...f.info.commandLine] : f.info.commandLine,
      );
      expect(options).toMatchObject({
        cwd: path.dirname(f.info.exePath),
        shell: false,
        detach: false,
      });
      expect(options.env.TOOL_MODE).toBe("test");
      if (proton) expect(options.env.STEAM_COMPAT_DATA_PATH).toBe(path.join(root, "compatdata"));
      if (result === "ENOENT") {
        expect(f.onShowError).toHaveBeenCalledWith(
          "Failed to run tool",
          expect.objectContaining({ Executable: f.info.exePath }),
          false,
        );
      }
      expect(await readFile(f.info.exePath)).toEqual(f.bytes);
    });
  }

  it(`handles the original native ENOENT after child close with Proton=${proton}`, async () => {
    const f = await fixture(proton);
    await rm(f.info.exePath);
    const closes = vi.fn<(code: number | null) => void>();
    f.runExecutable.mockImplementation((executable, args, options) => {
      const operation = new Bluebird<void>((resolve, reject) => {
        const child = spawn(executable, args, { cwd: options.cwd, shell: false, stdio: "ignore" });
        let failure: Error;
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) => {
          closes(code);
          if (failure !== undefined) reject(failure);
          else if (code !== 0) reject(new Error(`exit ${code}`));
          else resolve();
        });
      });
      nativeWork.push(operation);
      return operation;
    });
    const outcome = await StarterInfo.run(f.info, f.api, f.onShowError).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const outcomes = await Promise.all(
      nativeWork.map((operation) =>
        operation.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    expect(outcomes).toEqual([expect.objectContaining({ code: "ENOENT" })]);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(f.runExecutable).toHaveBeenCalledTimes(1);
    expect(catalog.runToolWithProton).toHaveBeenCalledTimes(proton ? 1 : 0);
    expect(outcome.error).toBeUndefined();
    expect(f.onShowError).toHaveBeenCalledExactlyOnceWith(
      "Failed to run tool",
      expect.any(Object),
      false,
    );
  });

  it(`recovers the hidden window after execution with Proton=${proton}`, async () => {
    const f = await fixture(proton);
    f.info.onStart = "hide_recover";
    const hide = vi.fn<() => Promise<void>>(async () => {});
    const show = vi.fn<() => Promise<void>>(async () => {});
    const isVisible = vi.fn<() => Promise<boolean>>(async () => false);
    window.api.window = { ...previousWindow, hide, show, isVisible };
    const launched: Bluebird<void>[] = [];
    f.runExecutable.mockImplementation((_exe, _args, options) => {
      options.onSpawned?.();
      const original = Bluebird.resolve();
      launched.push(original);
      return original;
    });
    await StarterInfo.run(f.info, f.api, f.onShowError);
    await Promise.all(launched);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(isVisible).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(f.onShowError).not.toHaveBeenCalled();
  });
}
