import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

import { makeApiHarness, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import * as paths from "../../util/getVortexPath";
import init from "./index";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-state-backup-"));
  roots.push(root);
  const original = paths.default;
  vi.spyOn(paths, "default").mockImplementation((id) => (id === "userData" ? root : original(id)));
  const h = makeApiHarness({
    profiles: { p: makeProfile({ id: "p", enabledModsBeforeDisable: ["remembered-mod"] }) },
  });
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "backup-test" };
    state.user = { multiUser: false };
  });
  let props: () => { onCreateManualBackup: () => unknown };
  init({
    api: h.api,
    once: () => undefined,
    registerSettings: (_title, _component, makeProps) => {
      props = makeProps;
    },
    registerAction: () => undefined,
  } as unknown as IExtensionContext);
  return { h, root, create: () => props().onCreateManualBackup() };
}

it("offers the actual manual backup only after writing the selected hives", async () => {
  const { h, root, create } = await setup();
  await create();
  await vi.waitFor(() => expect(h.notifications).toHaveLength(1));
  expect(h.notifications[0]).toEqual(
    expect.objectContaining({ type: "success", message: "Backup created" }),
  );
  const saved = JSON.parse(
    await readFile(path.join(root, "temp/state_backups_full/manual.json"), "utf8"),
  );
  expect(saved.persistent.profiles.p.enabledModsBeforeDisable).toEqual(["remembered-mod"]);
  expect(Object.keys(saved).sort()).toEqual(["app", "persistent", "settings", "user"]);
  expect(saved).not.toHaveProperty("session");
  expect(saved).not.toHaveProperty("confidential");
});

it("reports a failed manual backup without offering a false success or copy action", async () => {
  const { h, create } = await setup();
  const failure = Object.assign(new Error("fixture backup denied"), { code: "EACCES" });
  vi.spyOn(fs, "ensureDirWritableAsync").mockImplementationOnce(() => Bluebird.reject(failure));
  await create();
  await vi.waitFor(() =>
    expect(h.notifications.some((notification) => notification.type === "error")).toBe(true),
  );
  expect(h.notifications.map((notification) => notification.type)).toEqual(["error"]);
});
