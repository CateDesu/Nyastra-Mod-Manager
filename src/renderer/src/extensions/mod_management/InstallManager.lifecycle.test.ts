import { afterEach, expect, vi } from "vitest";

import { makeGameStored, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/installManagerTest";
import { ProcessCanceled, UserCanceled } from "../../util/CustomErrors";

afterEach(() => vi.restoreAllMocks());

test("a failed public install calls its callback once and clears active tracking", async ({
  makeInstallManager,
}) => {
  const h = makeInstallManager();
  const callback = vi.fn();

  h.manager.install(
    null,
    "/tmp/mod.7z",
    ["skyrimse"],
    h.api,
    {},
    false,
    false,
    callback,
    "skyrimse",
  );
  await vi.waitFor(() => expect(h.manager.getActiveInstallations()).toHaveLength(0), {
    timeout: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(ProcessCanceled), null);
  expect(h.manager.getActiveInstallationCount()).toBe(0);
});

test("simultaneous direct installs keep separate tracking until each attempt finishes", async ({
  makeInstallManager,
}) => {
  const h = makeInstallManager({
    knownGames: [makeGameStored()],
    profiles: { p: makeProfile({ id: "p" }) },
    activeProfileId: "p",
  });
  const releases: Record<string, () => void> = {};
  const gates = Object.fromEntries(
    ["first", "second"].map((name) => [
      name,
      new Promise<void>((resolve) => {
        releases[name] = resolve;
      }),
    ]),
  );
  const started = new Set<string>();
  vi.spyOn(h.api, "emitAndAwait").mockImplementation(async (event, _game, _archive, modId) => {
    if (event === "will-install-mod") {
      started.add(modId as string);
      await gates[modId as string];
      throw new UserCanceled();
    }
    return [];
  });
  const first = vi.fn();
  const second = vi.fn();
  h.manager.install(
    null,
    "/tmp/first.7z",
    ["skyrimse"],
    h.api,
    {},
    false,
    false,
    first,
    "skyrimse",
  );
  h.manager.install(
    null,
    "/tmp/second.7z",
    ["skyrimse"],
    h.api,
    {},
    false,
    false,
    second,
    "skyrimse",
  );
  try {
    await vi.waitFor(() => expect(started.size).toBe(2), { timeout: 1000 });
    expect(
      h.manager
        .getActiveInstallations()
        .map((entry) => entry.archivePath)
        .sort(),
    ).toEqual(["/tmp/first.7z", "/tmp/second.7z"]);
    expect(h.manager.getActiveInstallationCount()).toBe(2);
    releases.first();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(second).not.toHaveBeenCalled();
    expect(h.manager.getActiveInstallations()).toEqual([
      expect.objectContaining({ archivePath: "/tmp/second.7z" }),
    ]);
    expect(h.manager.getActiveInstallationCount()).toBe(1);
  } finally {
    releases.first();
    releases.second();
    await vi.waitFor(() => expect(h.manager.getActiveInstallations()).toHaveLength(0), {
      timeout: 1000,
    });
    await vi.waitFor(() => expect(second).toHaveBeenCalled(), { timeout: 1000 });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(first).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), null);
  expect(second).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), null);
});
