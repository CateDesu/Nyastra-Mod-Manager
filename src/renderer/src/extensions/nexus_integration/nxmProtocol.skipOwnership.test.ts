import Bluebird from "bluebird";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  finishInstallSession,
  startInstallSession,
  updateModStatus,
} from "../../actions/collectionInstallTracking";
import {
  makeInstallState,
  makeMod,
  makeModInstallInfo,
  makeNxmHarness,
  makeReference,
  makeRule,
  makeSession,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { INxmHarness } from "../../test-utils/harnessTypes";
import { FREE, MOD_URL } from "../../test-utils/nxmTest";
import { modRuleId } from "../../util/collectionInstallSession";
import { UserCanceled } from "../../util/CustomErrors";
import type opn from "../../util/opn";
import { batchDispatch } from "../../util/util";
import { NxmProtocol } from "./nxmProtocol";
import type * as nexusUtil from "./util";
import { getInfoGraphQL } from "./util";

vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof nexusUtil>()),
  bringToFront: vi.fn<typeof nexusUtil.bringToFront>(),
  getInfoGraphQL: vi.fn<typeof nexusUtil.getInfoGraphQL>(),
}));
vi.mock("../../util/opn", () => ({ default: vi.fn<typeof opn>(() => Promise.resolve()) }));

const NativePromise = globalThis.Promise;
const rule = makeRule({
  type: "requires",
  reference: makeReference({
    tag: "shared-member",
    repo: { repository: "nexus", gameId: "skyrimse", modId: "100", fileId: "500" },
  }),
});
const sibling = makeRule({
  type: "requires",
  reference: makeReference({
    tag: "sibling",
    repo: { repository: "nexus", gameId: "skyrimse", modId: "200", fileId: "600" },
  }),
});
const SIBLING_URL = "nxm://skyrimspecialedition/mods/200/files/600";
const ruleId = modRuleId(rule);
const siblingId = modRuleId(sibling);
const session = (collectionId: string) =>
  makeSession({
    sessionId: `${collectionId}_profile`,
    collectionId,
    profileId: "profile",
    gameId: "skyrimse",
    totalRequired: 2,
    mods: {
      [ruleId]: makeModInstallInfo({ rule, status: "pending" }),
      [siblingId]: makeModInstallInfo({ rule: sibling, status: "pending" }),
    },
  });

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function enqueue(harness: INxmHarness, nxm: NxmProtocol, input = MOD_URL) {
  const ready = gate<void>();
  const count = () =>
    harness.dispatched.filter((action) => action.type === "ADD_FREEUSER_DLITEM").length;
  const before = count();
  const unsubscribe = harness.api.store.subscribe(() => {
    if (count() > before) ready.resolve();
  });
  const completed = vi.fn<(outcome: "resolved" | "rejected") => void>();
  const pending = nxm.resolve(input).then(
    (value) => {
      completed("resolved");
      return { value, error: undefined };
    },
    (error: unknown) => {
      completed("rejected");
      return { value: undefined, error };
    },
  );
  await ready.promise;
  unsubscribe();
  return { pending, completed };
}

afterEach(() => {
  resetHarnessRegistries();
  vi.restoreAllMocks();
});
afterAll(() => {
  globalThis.Promise = NativePromise;
});

for (const runtime of ["native", "built-in Bluebird"] as const) {
  describe(`free-user Skip ownership with ${runtime}`, () => {
    beforeAll(async () => {
      if (runtime === "built-in Bluebird") {
        await import("../mod_management/index.js");
        expect(globalThis.Promise).toBe(Bluebird);
      } else {
        expect(globalThis.Promise).toBe(NativePromise);
      }
    });

    test.each([
      "current",
      "sibling-progress",
      "sibling-skip",
      "cancel",
      "replacement",
      "cancel-replacement",
      "same-id-retry",
      "same-id-restart",
      "batched-same-id-retry",
      "cancel-same-id-retry",
      "retired",
      "query-failure",
      "authorized-link",
      "no-session",
    ] as const)("settles the initiating download once: %s", async (mode) => {
      vi.mocked(getInfoGraphQL).mockResolvedValue({
        modInfo: { direct_download_enabled: false },
        fileInfo: {},
      } as never);
      const harness = makeNxmHarness({
        userInfo: FREE,
        mods: {
          skyrimse: {
            old: makeMod({ id: "old", type: "collection", rules: [rule, sibling] }),
            replacement: makeMod({
              id: "replacement",
              type: "collection",
              rules: [rule, sibling],
            }),
          },
        },
        session: makeInstallState({
          activeSession: mode === "no-session" ? undefined : session("old"),
        }),
      });
      const subscribe = harness.api.store.subscribe.bind(harness.api.store);
      const subscriptions = new Set<() => void>();
      vi.spyOn(harness.api.store, "subscribe").mockImplementation((listener) => {
        const unsubscribe = subscribe(listener);
        subscriptions.add(unsubscribe);
        return () => {
          subscriptions.delete(unsubscribe);
          unsubscribe();
        };
      });
      const nxm = new NxmProtocol(harness.api, () => harness.nexus);
      nxm.start();
      const baselineSubscriptions = subscriptions.size;
      const baselineStartListeners = harness.api.events.listenerCount("will-install-collection");
      const entered = gate<void>();
      const reply = gate<{ file_updates: [] }>();
      harness.getModFiles.mockImplementation(() => {
        entered.resolve();
        return reply.promise;
      });
      const old = await enqueue(harness, nxm);
      const skip = nxm.dialogHandlers.onSkip(MOD_URL);
      expect(skip).toBeInstanceOf(NativePromise);
      let current: Awaited<ReturnType<typeof enqueue>> | undefined;
      let siblingDownload: Awaited<ReturnType<typeof enqueue>> | undefined;
      try {
        await entered.promise;
        expect(harness.getModFiles).toHaveBeenCalledTimes(1);
        if (mode.startsWith("cancel")) {
          expect(nxm.dialogHandlers.onCancel(MOD_URL)).toBe(true);
          await old.pending;
          expect(harness.freeUserQueue()).toEqual([]);
        }
        if (mode === "sibling-progress") {
          harness.api.store.dispatch(updateModStatus("old_profile", siblingId, "downloading"));
        }
        if (mode === "sibling-skip") {
          siblingDownload = await enqueue(harness, nxm, SIBLING_URL);
          harness.getModFiles.mockResolvedValue({ file_updates: [] });
          await nxm.dialogHandlers.onSkip(SIBLING_URL);
          expect((await siblingDownload.pending).error).toBeInstanceOf(UserCanceled);
          expect(siblingDownload.completed).toHaveBeenCalledExactlyOnceWith("rejected");
          expect(harness.getState().session.collections.activeSession.mods[siblingId].status).toBe(
            "ignored",
          );
          expect(harness.getState().persistent.mods.skyrimse.old.rules[1].ignored).toBe(true);
          expect(harness.freeUserQueue()).toEqual([MOD_URL]);
        }
        const retry = mode.includes("retry");
        const replacement = mode.includes("replacement") || mode === "no-session";
        const restart = mode === "same-id-restart";
        if (retry || replacement || restart || mode === "retired") {
          const next = session(retry || restart ? "old" : "replacement");
          const finish = finishInstallSession("old_profile", false);
          if (restart) harness.api.events.emit("will-install-collection", "skyrimse", "old");
          if (mode === "batched-same-id-retry") {
            batchDispatch(harness.api.store, [finish, startInstallSession(next)]);
          } else {
            if (retry || mode === "retired") harness.api.store.dispatch(finish);
            if (mode !== "retired") harness.api.store.dispatch(startInstallSession(next));
          }
          if (mode !== "retired") current = await enqueue(harness, nxm);
        }
        if (mode === "authorized-link") {
          harness.getDownloadURLs.mockResolvedValue([
            { URI: "https://cdn/member.7z", short_name: "cdn", name: "CDN" },
          ]);
          nxm.dialogHandlers.onDownload(MOD_URL);
          await nxm.handleLink(`${MOD_URL}?key=authorized&expires=1700000000`, false);
          await old.pending;
        }
        if (mode === "query-failure") reply.reject(new Error("history unavailable"));
        else reply.resolve({ file_updates: [] });
        await skip;
        const outcome = await old.pending;
        const valid = mode === "current" || mode === "sibling-progress" || mode === "sibling-skip";
        const active = harness.getState().session.collections.activeSession;
        expect(old.completed).toHaveBeenCalledTimes(1);
        expect(old.completed).toHaveBeenCalledWith(
          mode === "authorized-link" ? "resolved" : "rejected",
        );
        if (mode === "authorized-link") {
          expect(outcome.value?.urls).toEqual(["https://cdn/member.7z"]);
        } else {
          expect(outcome.error).toBeInstanceOf(UserCanceled);
        }
        expect
          .soft(active?.mods[ruleId].status)
          .toBe(mode === "retired" ? undefined : valid ? "ignored" : "pending");
        expect
          .soft(active?.ignoredCount)
          .toBe(mode === "retired" ? undefined : mode === "sibling-skip" ? 2 : valid ? 1 : 0);
        expect
          .soft(harness.getState().persistent.mods.skyrimse.old.rules[0].ignored)
          .toBe(valid ? true : undefined);
        expect
          .soft(harness.getState().persistent.mods.skyrimse.replacement.rules[0].ignored)
          .toBeUndefined();
        expect(subscriptions.size).toBe(baselineSubscriptions);
        expect(harness.api.events.listenerCount("will-install-collection")).toBe(
          baselineStartListeners,
        );
        if (current !== undefined) {
          expect(current.completed).not.toHaveBeenCalled();
          expect(harness.freeUserQueue()).toEqual([MOD_URL]);
          harness.getModFiles.mockResolvedValue({ file_updates: [] });
          await nxm.dialogHandlers.onSkip(MOD_URL);
          const currentOutcome = await current.pending;
          expect(currentOutcome.error).toBeInstanceOf(UserCanceled);
          expect(current.completed).toHaveBeenCalledExactlyOnceWith("rejected");
          expect(harness.getState().session.collections.activeSession.mods[ruleId].status).toBe(
            "ignored",
          );
          expect(
            harness.getState().persistent.mods.skyrimse[active.collectionId].rules[0].ignored,
          ).toBe(true);
        }
        expect(harness.freeUserQueue()).toEqual([]);
        expect(subscriptions.size).toBe(baselineSubscriptions);
        expect(harness.api.events.listenerCount("will-install-collection")).toBe(
          baselineStartListeners,
        );
        expect(nxm.dialogHandlers.onCancel(MOD_URL)).toBe(false);
      } finally {
        reply.resolve({ file_updates: [] });
        await skip;
        nxm.dialogHandlers.onCancel(MOD_URL);
        await old.pending;
        await current?.pending;
        await siblingDownload?.pending;
      }
    });
  });
}
