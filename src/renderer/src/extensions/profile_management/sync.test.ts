import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, test, vi } from "vitest";

import { UserCanceled } from "../../util/CustomErrors";
import * as atomic from "../../util/fsAtomic";
import { syncFromProfile, syncToProfile } from "./sync";

afterEach(() => vi.restoreAllMocks());

for (const [direction, canceled] of [
  ["save", false],
  ["restore", false],
  ["save", true],
  ["restore", true],
] as const) {
  test(`failed ${direction} settles every copy before permitting retries, canceled=${canceled}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "profile-settlement-"));
    const live = path.join(root, "live");
    const first = path.join(root, "A");
    const next = path.join(root, "B");
    for (const directory of [live, first, next]) {
      await mkdir(directory);
      for (const filename of ["one.ini", "two.ini"]) {
        await writeFile(
          path.join(directory, filename),
          directory === next ? "B settings" : "A settings",
        );
      }
    }
    const files = ["one.ini", "two.ini"].map((name) => path.join(live, name));
    const gate = Bluebird.defer<void>();
    const entered = Bluebird.defer<void>();
    const copied = Bluebird.defer<void>();
    const reported = Bluebird.defer<void>();
    const failure = canceled
      ? new UserCanceled()
      : Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const copy = atomic.copyFileAtomic;
    let initial = true;
    const spy = vi.spyOn(atomic, "copyFileAtomic").mockImplementation((source, destination) => {
      if (!initial) return copy(source, destination);
      if (source.endsWith("one.ini")) {
        return entered.promise.then(() => {
          reported.resolve();
          throw failure;
        });
      }
      entered.resolve();
      return gate.promise.then(() => copy(source, destination)).finally(() => copied.resolve());
    });
    const sync = direction === "save" ? syncToProfile : syncFromProfile;
    let settled = false;
    const onError = vi.fn();
    const failed = sync(first, files, onError).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await reported.promise;
      await Bluebird.delay(20);
      expect(settled).toBe(false);
      gate.resolve();
      expect(await failed).toBe(failure);
      expect(onError).toHaveBeenCalledTimes(canceled ? 0 : 1);
      await copied.promise;
      initial = false;
      if (direction === "save") await syncToProfile(first, files, () => undefined);
      await syncFromProfile(next, files, () => undefined);
      expect(
        await readFile(path.join(direction === "save" ? first : live, "two.ini"), "utf8"),
      ).toBe(direction === "save" ? "A settings" : "B settings");
    } finally {
      gate.resolve();
      await failed;
      await copied.promise;
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
}
