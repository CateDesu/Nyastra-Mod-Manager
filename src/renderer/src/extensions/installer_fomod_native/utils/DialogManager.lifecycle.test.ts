import { expect, vi } from "vitest";

import { makeApiHarness } from "../../../test-utils/builders";
import { test } from "../../../test-utils/harnessTest";
import { installerUIReducer } from "../../installer_fomod_shared/reducers/installerUI";
import { DialogQueue } from "../../installer_fomod_shared/utils/DialogQueue";
import { hasSessionFOMOD } from "../../installer_fomod_shared/utils/guards";
import { DialogManager } from "./DialogManager";

const h = () =>
  makeApiHarness({}, [
    { path: ["session", "fomod", "installer", "dialog"], reducer: installerUIReducer },
  ]);

test("disposal releases the active dialog before a delayed native end callback", async () => {
  const harness = h();
  const queue = DialogQueue.getInstance(harness.api);
  const state = () => {
    const session = harness.getState().session;
    if (!hasSessionFOMOD(session)) throw new Error("missing FOMOD reducer");
    return session.fomod.installer.dialog;
  };
  const first = new DialogManager(harness.api, "first", "/fixture");
  const next = new DialogManager(harness.api, "next", "/fixture");
  try {
    for (const manager of [first, next]) {
      manager.enqueueDialog("Fixture", undefined, vi.fn(), vi.fn(), vi.fn());
      manager.updateDialogState([], 0);
    }
    expect(state().activeInstanceId).toBe("first");
    expect(queue.getStatus().queueLength).toBe(1);

    first.dispose();

    expect(state().activeInstanceId).toBe("next");
    expect(state().instances.first).toBeUndefined();
    for (const event of ["select", "continue", "cancel"]) {
      expect(harness.api.events.listenerCount(`fomod-installer-${event}-first`)).toBe(0);
    }
    first.endDialog();
    expect(state().activeInstanceId).toBe("next");
    next.dispose();
    expect(state().activeInstanceId).toBeNull();
    expect(queue.getStatus().queueLength).toBe(0);
  } finally {
    harness.api.events.removeAllListeners();
    queue.clear();
    queue.destroy();
  }
});
