import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExtensionManager from "./ExtensionManager";
import NXMUrl from "./extensions/nexus_integration/NXMUrl";
import { makeNxmHarness } from "./test-utils/builders";
import { deregisterProtocolHandler, registerProtocolHandler } from "./util/protocolRegistration";

vi.mock("./util/protocolRegistration", () => ({
  registerProtocolHandler: vi.fn(() => Promise.resolve(true)),
  deregisterProtocolHandler: vi.fn(() => Promise.resolve()),
}));
vi.mock("./IPCDownloadAdapter", () => ({ IPCDownloadAdapter: class {} }));
vi.mock("fs-extra", async (importOriginal) => {
  const actual = await importOriginal<{ default: object }>();
  return { ...actual.default, ...actual, readdirSync: vi.fn(() => []) };
});
vi.mock("./views/layout/ToastContainer", () => ({ isToastSystemDisabled: () => true }));

beforeEach(() => {
  const prototype = ExtensionManager.prototype as unknown as {
    prepareExtensions: () => [];
    initExtensions: () => void;
  };
  vi.spyOn(prototype, "prepareExtensions").mockReturnValue([]);
  vi.spyOn(prototype, "initExtensions").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("protocol registration and external URL dispatch", () => {
  for (const registeredScheme of ["nxm", "NXM", "nXm"]) {
    for (const incomingScheme of ["nxm", "NXM", "nXm"]) {
      it(`dispatches ${incomingScheme} links registered as ${registeredScheme} without changing URL bytes`, async () => {
        const harness = makeNxmHarness();
        const manager = new ExtensionManager({}, harness.api.events);
        const api = manager.getApi();
        const state = harness.api.getState();
        api.getState = (() => ({
          ...state,
          session: {
            ...state.session,
            base: { ...state.session.base, commandLine: {} },
          },
        })) as typeof api.getState;
        const url = `${incomingScheme}://Fallout4/mods/123/files/456?key=AbC%2BXyZ&expires=1700000000&user_id=42`;
        const received = vi.fn((original: string, install: boolean) => {
          const parsed = new NXMUrl(original);
          expect(parsed.key).toBe("AbC+XyZ");
          expect(parsed.modId).toBe(123);
          expect(parsed.fileId).toBe(456);
          expect(install).toBe(true);
        });

        await api.registerProtocol(registeredScheme, false, received);
        const handler = manager.getProtocolHandler(url.split(":")[0]);
        expect(handler).not.toBeNull();
        handler?.(url, true);

        expect(received).toHaveBeenCalledExactlyOnceWith(url, true);
        expect(registerProtocolHandler).toHaveBeenCalledExactlyOnceWith({
          protocol: "nxm",
          setAsDefault: false,
          userDataPath: undefined,
        });
        await api.deregisterProtocol(registeredScheme);
        expect(deregisterProtocolHandler).toHaveBeenCalledExactlyOnceWith("nxm", undefined);
      });
    }
  }
});
