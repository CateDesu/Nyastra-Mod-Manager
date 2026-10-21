import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as FomodNative from "@nexusmods/fomod-installer-native";
import { expect, vi } from "vitest";

const delayed = vi.hoisted(() => ({
  ends: [] as Array<() => void>,
  cancelPending: [] as Array<() => void>,
  failResult: false,
}));

vi.mock("../../util/lazyRequire", () => ({
  default: (load: () => unknown) => {
    const loaded = load() as typeof FomodNative;
    if (!loaded.NativeModInstaller) return loaded;
    return {
      ...loaded,
      NativeModInstaller: class extends loaded.NativeModInstaller {
        private control: { settled: boolean; cancel?: () => void };

        constructor(...args: ConstructorParameters<typeof FomodNative.NativeModInstaller>) {
          const control = { settled: false, cancel: undefined as (() => void) | undefined };
          const start = args[4];
          args[4] = (...callbacks) => {
            control.cancel = callbacks[4];
            return start(...callbacks);
          };
          const end = args[5];
          args[5] = () => delayed.ends.push(end);
          super(...args);
          this.control = control;
          delayed.cancelPending.push(() => {
            if (!control.settled) control.cancel?.();
          });
        }

        async install(...args: Parameters<FomodNative.NativeModInstaller["install"]>) {
          try {
            const result = await super.install(...args);
            if (delayed.failResult) throw new Error("native completion failure");
            return result;
          } finally {
            this.control.settled = true;
          }
        }
      },
    };
  },
}));

import { makeApiHarness } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { installerUIReducer } from "../installer_fomod_shared/reducers/installerUI";
import { DialogQueue } from "../installer_fomod_shared/utils/DialogQueue";
import { hasSessionFOMOD } from "../installer_fomod_shared/utils/guards";
import { install } from "./installer";

test("native installs release the queue and save choices before delayed end callbacks arrive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-native-install-"));
  const h = makeApiHarness({}, [
    { path: ["session", "fomod", "installer", "dialog"], reducer: installerUIReducer },
  ]);
  const queue = DialogQueue.getInstance(h.api);
  const state = () => {
    const session = h.getState().session;
    if (!hasSessionFOMOD(session)) throw new Error("missing FOMOD reducer");
    return session.fomod.installer.dialog;
  };
  const pending: Promise<unknown>[] = [];
  try {
    await mkdir(path.join(directory, "fomod"));
    await writeFile(path.join(directory, "payload.txt"), "fixture");
    await writeFile(
      path.join(directory, "fomod/ModuleConfig.xml"),
      `
      <config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd"><moduleName>Fixture</moduleName>
        <installSteps order="Explicit"><installStep name="Choose">
          <optionalFileGroups order="Explicit"><group name="Choice" type="SelectAll">
            <plugins order="Explicit"><plugin name="Option"><description>Fixture</description>
              <files><file source="payload.txt" destination="payload.txt" /></files>
              <typeDescriptor><type name="Required" /></typeDescriptor>
            </plugin></plugins>
          </group></optionalFileGroups>
        </installStep></installSteps>
      </config>`,
    );
    const start = () => {
      const result = install(
        h.api,
        ["fomod/ModuleConfig.xml", "payload.txt"],
        directory,
        "skyrimse",
      );
      void result.catch(() => undefined);
      pending.push(result);
      return result;
    };
    const first = start();
    await vi.waitFor(() => expect(state().activeInstanceId).toBeTruthy());
    const firstId = state().activeInstanceId;
    const second = start();
    await vi.waitFor(() => expect(queue.getStatus().queueLength).toBe(1));
    h.api.events.emit(`fomod-installer-continue-${firstId}`, "finish", 0);
    const result = await first;
    expect(result.instructions).toContainEqual(
      expect.objectContaining({
        type: "attribute",
        key: "installerChoices",
        value: {
          type: "fomod",
          options: [
            { name: "Choose", groups: [{ name: "Choice", choices: [{ name: "Option", idx: 0 }] }] },
          ],
        },
      }),
    );
    expect(state().activeInstanceId).toBeTruthy();
    expect(state().activeInstanceId).not.toBe(firstId);
    expect(state().instances[firstId]).toBeUndefined();
    const secondId = state().activeInstanceId;
    await vi.waitFor(() => expect(delayed.ends).toHaveLength(1));
    expect(() => delayed.ends.shift()?.()).not.toThrow();
    expect(state().activeInstanceId).toBe(secondId);

    h.api.events.emit(`fomod-installer-continue-${secondId}`, "finish", 0);
    await second;
    await vi.waitFor(() => expect(delayed.ends).toHaveLength(1));
    expect(() => delayed.ends.shift()?.()).not.toThrow();
    expect(state().activeInstanceId).toBeNull();
    expect(state().instances).toEqual({});
    expect(queue.getStatus().queueLength).toBe(0);

    const canceled = start();
    await vi.waitFor(() => expect(state().activeInstanceId).toBeTruthy());
    h.api.events.emit(`fomod-installer-cancel-${state().activeInstanceId}`);
    await expect(canceled).rejects.toMatchObject({ name: "UserCanceled" });
    expect(state().activeInstanceId).toBeNull();
    expect(state().instances).toEqual({});

    delayed.failResult = true;
    const failed = start();
    await vi.waitFor(() => expect(state().activeInstanceId).toBeTruthy());
    h.api.events.emit(`fomod-installer-continue-${state().activeInstanceId}`, "finish", 0);
    await expect(failed).rejects.toThrow("native completion failure");
    expect(state().activeInstanceId).toBeNull();
    expect(state().instances).toEqual({});
    await vi.waitFor(() => expect(delayed.ends).toHaveLength(1));
    expect(() => delayed.ends.shift()?.()).not.toThrow();
  } finally {
    for (const cancel of delayed.cancelPending) cancel();
    await Promise.allSettled(pending);
    h.api.events.removeAllListeners();
    queue.clear();
    queue.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
