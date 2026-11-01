import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setToolPid } from "../../../actions";
import {
  defaultState,
  hasExclusiveToolRunning,
  makeExeId,
  sessionReducer,
} from "../../../reducers/session";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import ProcessMonitor from "./ProcessMonitor";
import type { IProcessInfo, IProcessProvider } from "./processProvider";

const nativeProbe = (async () => {
  await Bluebird.resolve();
})();
const NativePromise = nativeProbe.constructor as PromiseConstructor;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(operation: PromiseLike<T>): Promise<Outcome<T>> {
  return NativePromise.resolve(operation).then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function createMonitor(configured: string, list: IProcessProvider["list"]) {
  let state = {
    session: {
      base: { ...defaultState, toolsRunning: {} },
      gameMode: {
        known: [{ id: "selected", executable: path.basename(configured), requiredFiles: [] }],
      },
    },
    settings: {
      profiles: { activeProfileId: "selected-profile" },
      gameMode: {
        discovered: {
          selected: {
            path: path.dirname(configured),
            executable: path.basename(configured),
            tools: {},
          },
        },
      },
    },
    persistent: {
      profiles: { "selected-profile": { id: "selected-profile", gameId: "selected" } },
    },
  } as unknown as IState;
  const actions: ReturnType<typeof setToolPid>[] = [];
  const store = {
    getState: () => state,
    dispatch: (action: ReturnType<typeof setToolPid>) => {
      actions.push(action);
      const reduce = sessionReducer.reducers[action.type];
      if (reduce) {
        state = {
          ...state,
          session: { ...state.session, base: reduce(state.session.base, action.payload) },
        };
      }
      return action;
    },
  };
  const callbacks: Promise<Outcome<IProcessInfo[]>>[] = [];
  const provider = {
    list: vi.fn<IProcessProvider["list"]>(() => {
      const operation = list();
      callbacks.push(settle(operation));
      return operation;
    }),
  };
  const monitor = new ProcessMonitor({ store } as unknown as IExtensionApi, provider);
  const observed = monitor as unknown as { doCheck(): Promise<void> };
  const original = observed.doCheck.bind(monitor) as () => Promise<void>;
  const checks: Promise<Outcome<void>>[] = [];
  vi.spyOn(observed, "doCheck").mockImplementation(() => {
    const check = original();
    checks.push(settle(check));
    return check;
  });
  return {
    monitor,
    provider,
    actions,
    callbacks,
    checks,
    getRunning: () => state.session.base.toolsRunning,
  };
}

type Monitor = ReturnType<typeof createMonitor>;

async function poll(harness: Monitor): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  harness.monitor.start();
  await vi.advanceTimersByTimeAsync(2000);
  await NativePromise.all(harness.checks);
  harness.monitor.end();
  await NativePromise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
}

async function drain(harness: Monitor | undefined): Promise<void> {
  const outcomes = [
    await capture(() => harness?.monitor.end()),
    await capture(() => vi.useRealTimers()),
    await capture(() => NativePromise.all(harness?.callbacks ?? [])),
    await capture(() => NativePromise.all(harness?.checks ?? [])),
    await capture(() => harness?.monitor.end()),
  ];
  const errors = outcomes.flatMap((outcome) => ("error" in outcome ? [outcome.error] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Process monitor cleanup failed");
  }
}

function capture(operation: () => unknown): Promise<Outcome<unknown>> {
  return settle(NativePromise.resolve().then(operation));
}

async function pollAndDrain(harness: Monitor): Promise<void> {
  const primary = await settle(poll(harness));
  const cleanup = await settle(drain(harness));
  if ("error" in primary) {
    if ("error" in cleanup) {
      console.error("Process monitor cleanup also failed", cleanup.error);
    }
    throw primary.error;
  }
  if ("error" in cleanup) {
    throw cleanup.error;
  }
}

function expectChecked(harness: Monitor): void {
  expect(harness.provider.list).toHaveBeenCalledTimes(1);
  expect(harness.checks).toHaveLength(1);
}

beforeEach(async () => {
  await nativeProbe;
  vi.stubGlobal("Promise", Bluebird);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scenarios = ["same path", "unrelated path", "directory case", "executable case"] as const;

for (const field of ["path", "cmd"] as const) {
  for (const scenario of scenarios) {
    it(`preserves native Linux ${field} identity for ${scenario}`, async () => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "process-path-")));
      const configured = path.join(root, "Managed", "nyastra-runner");
      const actual =
        scenario === "same path"
          ? configured
          : scenario === "directory case"
            ? path.join(root, "managed", "nyastra-runner")
            : scenario === "executable case"
              ? path.join(root, "Managed", "Nyastra-Runner")
              : path.join(root, "Other", "nyastra-runner");
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<void> | undefined;
      let nativeClosed = false;
      const childErrors: Error[] = [];
      let harness: Monitor | undefined;
      let primary: Outcome<void> = { ok: true, value: undefined };
      const cleanupErrors: unknown[] = [];
      const attempt = async (operation: () => unknown) => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      try {
        expect(globalThis.Promise).toBe(Bluebird);
        expect(NativePromise).not.toBe(Bluebird);
        expect(await realpath(os.tmpdir())).toBe(path.dirname(root));
        await mkdir(path.dirname(configured), { recursive: true });
        await mkdir(path.dirname(actual), { recursive: true });
        await copyFile("/usr/bin/sleep", configured);
        await chmod(configured, 0o700);
        if (actual !== configured) {
          await copyFile("/usr/bin/sleep", actual);
          await chmod(actual, 0o700);
        }
        const [configuredStat, actualStat] = await NativePromise.all([
          stat(configured),
          stat(actual),
        ]);
        expect(actualStat.isFile()).toBe(true);
        expect(actualStat.dev === configuredStat.dev && actualStat.ino === configuredStat.ino).toBe(
          scenario === "same path",
        );
        child = spawn(actual, ["10"], { stdio: "ignore" });
        const spawned = new NativePromise<Outcome<void>>((resolve) => {
          child.once("spawn", () => resolve({ ok: true, value: undefined }));
          child.once("error", (error) => {
            childErrors.push(error);
            resolve({ ok: false, error });
          });
        });
        closed = new NativePromise((resolve) => {
          child.once("close", () => {
            nativeClosed = true;
            resolve();
          });
        });
        const ready = await spawned;
        if ("error" in ready) {
          throw ready.error;
        }
        const pid = child.pid;
        if (pid === undefined) {
          throw new Error("Native child has no PID after spawn");
        }
        harness = createMonitor(configured, async () => {
          const [exe, rawCmd, rawStat, procStat] = await NativePromise.all([
            readlink(`/proc/${pid}/exe`),
            readFile(`/proc/${pid}/cmdline`),
            readFile(`/proc/${pid}/stat`, "utf8"),
            stat(`/proc/${pid}/exe`),
          ]);
          const fields = rawStat.slice(rawStat.lastIndexOf(")") + 2).split(" ");
          expect(fields[0]).not.toBe("Z");
          expect(Number(rawStat.slice(0, rawStat.indexOf(" ")))).toBe(pid);
          expect(Number(fields[1])).toBe(process.pid);
          expect(exe).toBe(actual);
          expect(rawCmd.toString().split("\0")).toEqual([actual, "10", ""]);
          expect([procStat.dev, procStat.ino]).toEqual([actualStat.dev, actualStat.ino]);
          const nativeProcess: IProcessInfo = {
            pid,
            ppid: Number(fields[1]),
            name: path.basename(exe),
          };
          return [
            field === "path"
              ? { ...nativeProcess, path: exe }
              : { ...nativeProcess, cmd: rawCmd.toString().replaceAll("\0", " ").trim() },
          ];
        });
        await poll(harness);
      } catch (error) {
        primary = { ok: false, error };
      }

      // Attempt every cleanup and retain the first failure.
      await attempt(() => drain(harness));
      await attempt(() => {
        if (child && !nativeClosed) {
          child.kill("SIGKILL");
        }
      });
      await attempt(() => closed);
      await attempt(() => rm(root, { recursive: true, force: true }));
      await attempt(async () => {
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      });
      if ("error" in primary) {
        if (cleanupErrors.length > 0) {
          console.error("Process path cleanup also failed", cleanupErrors);
        }
        throw primary.error;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Process path cleanup failed");
      }
      if (harness === undefined || child === undefined) {
        throw new Error("Native monitor fixture did not start");
      }
      expect(nativeClosed).toBe(true);
      expect(childErrors).toEqual([]);
      expectChecked(harness);
      expect((await NativePromise.all(harness.callbacks)).map((outcome) => outcome.ok)).toEqual([
        true,
      ]);
      expect(await NativePromise.all(harness.checks)).toEqual([{ ok: true, value: undefined }]);
      const running = harness.getRunning();
      const samePath = scenario === "same path";
      expect(running, "Only the exact Linux executable may mark the managed game running").toEqual(
        samePath ? { [makeExeId(configured)]: { pid: child.pid, exclusive: true } } : {},
      );
      expect(hasExclusiveToolRunning(running)).toBe(samePath);
      expect(harness.actions).toEqual(samePath ? [setToolPid(configured, child.pid, true)] : []);
    });
  }
}

it("retains the pathless basename fallback", async () => {
  const configured = "/games/Managed/Game";
  const harness = createMonitor(configured, () =>
    NativePromise.resolve([{ pid: 3001, ppid: 0, name: "GAME", cmd: "GAME --argument" }]),
  );
  await pollAndDrain(harness);
  expectChecked(harness);
  expect((await NativePromise.all(harness.callbacks)).map((outcome) => outcome.ok)).toEqual([true]);
  expect(await NativePromise.all(harness.checks)).toEqual([{ ok: true, value: undefined }]);
  expect(harness.getRunning()).toEqual({ game: { pid: 3001, exclusive: true } });
  expect(hasExclusiveToolRunning(harness.getRunning())).toBe(true);
  expect(harness.actions).toEqual([setToolPid(configured, 3001, true)]);
});

for (const platform of ["win32", "darwin"]) {
  it(`retains case insensitive full paths on ${platform}`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const configured = "/games/Managed/Game";
    const harness = createMonitor(configured, () =>
      NativePromise.resolve([{ pid: 3001, ppid: 0, name: "GAME", path: "/GAMES/managed/GAME" }]),
    );
    try {
      Object.defineProperty(process, "platform", { value: platform });
      await pollAndDrain(harness);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
    expectChecked(harness);
    expect((await NativePromise.all(harness.callbacks)).map((outcome) => outcome.ok)).toEqual([
      true,
    ]);
    expect(await NativePromise.all(harness.checks)).toEqual([{ ok: true, value: undefined }]);
    expect(harness.getRunning()).toEqual({ game: { pid: 3001, exclusive: true } });
    expect(hasExclusiveToolRunning(harness.getRunning())).toBe(true);
    expect(harness.actions).toEqual([setToolPid(configured, 3001, true)]);
  });
}
