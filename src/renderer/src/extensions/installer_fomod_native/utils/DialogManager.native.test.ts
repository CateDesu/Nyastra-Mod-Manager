import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as FomodNative from "@nexusmods/fomod-installer-native";
import { expect, vi } from "vitest";

import { makeApiHarness } from "../../../test-utils/builders";
import { test } from "../../../test-utils/harnessTest";
import { installerUIReducer } from "../../installer_fomod_shared/reducers/installerUI";
import { DialogQueue } from "../../installer_fomod_shared/utils/DialogQueue";
import { hasSessionFOMOD } from "../../installer_fomod_shared/utils/guards";
import { getChoicesFromState } from "../../installer_fomod_shared/utils/helpers";
import { DialogManager } from "./DialogManager";

const { NativeModInstaller } = createRequire(path.resolve(process.cwd(), "../main/package.json"))(
  "@nexusmods/fomod-installer-native",
) as typeof FomodNative;

test("native cancellation releases its dialog and preserves the next installer's choices", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-fomod-dialog-"));
  const h = makeApiHarness({}, [
    { path: ["session", "fomod", "installer", "dialog"], reducer: installerUIReducer },
  ]);
  const queue = DialogQueue.getInstance(h.api);
  const dialogState = () => {
    const session = h.getState().session;
    if (!hasSessionFOMOD(session)) throw new Error("FOMOD reducer was not registered");
    return session.fomod.installer.dialog;
  };
  const installers: Array<{
    cancelIfPending: () => void;
    result: Promise<unknown>;
  }> = [];
  const start = (id: string) => {
    const manager = new DialogManager(h.api, id, directory);
    const end = vi.fn(() => manager.endDialog());
    const native = new NativeModInstaller(
      () => [],
      () => "1.0.0",
      () => "1.0.0",
      () => "1.0.0",
      manager.enqueueDialog,
      end,
      manager.updateDialogState,
    );
    const result = native.install(
      ["fomod/ModuleConfig.xml", "payload.txt"],
      [],
      "",
      directory,
      undefined,
      false,
      false,
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    installers.push({
      cancelIfPending: () => {
        if (!settled) manager.cancelDialogImmediate();
      },
      result,
    });
    return { manager, result, end };
  };
  try {
    await mkdir(path.join(directory, "fomod"));
    await writeFile(path.join(directory, "payload.txt"), "fixture");
    await writeFile(
      path.join(directory, "fomod/ModuleConfig.xml"),
      `<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">
        <moduleName>Fixture</moduleName>
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
    const first = start("canceled");
    await vi.waitFor(() => expect(dialogState().activeInstanceId).toBe("canceled"));
    const next = start("next");
    await vi.waitFor(() => expect(dialogState().instances.next?.state).toBeDefined());
    expect(queue.getStatus().queueLength).toBe(1);

    h.api.events.emit("fomod-installer-cancel-canceled");
    await expect(first.result).resolves.toBeNull();
    expect(first.end).not.toHaveBeenCalled();
    expect(dialogState().activeInstanceId).toBe("next");
    for (const event of ["select", "continue", "cancel"]) {
      expect(h.api.events.listenerCount(`fomod-installer-${event}-canceled`)).toBe(0);
    }
    expect(dialogState().instances.canceled).toBeUndefined();

    h.api.events.emit("fomod-installer-continue-next", "finish", 0);
    await expect(next.result).resolves.toMatchObject({
      instructions: expect.arrayContaining([
        expect.objectContaining({ type: "copy", destination: "payload.txt" }),
      ]),
    });
    expect(next.end).toHaveBeenCalledOnce();
    expect(getChoicesFromState(h.api, "next")?.[0]?.groups[0]?.choices[0]?.name).toBe("Option");
    next.manager.dispose();
    expect(dialogState().instances).toEqual({});
    expect(queue.getStatus().queueLength).toBe(0);
  } finally {
    for (const installer of installers) installer.cancelIfPending();
    await Promise.allSettled(installers.map((installer) => installer.result));
    h.api.events.removeAllListeners();
    queue.clear();
    queue.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
