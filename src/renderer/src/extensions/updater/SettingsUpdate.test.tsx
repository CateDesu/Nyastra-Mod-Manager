import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LinuxUpdateCheck } from "@vortex/shared/ipc";
import React from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addNotification,
  dismissNotification,
  fireNotificationAction,
} from "@/actions/notifications";
import { notificationsReducer } from "@/reducers/notifications";
import { makeApiHarness } from "@/test-utils/builders";

import { setUpdateChannel } from "./actions";
import { checkForUpdates, startUpdateChecks } from "./checkForUpdates";
import settingsReducer, { sessionReducer } from "./reducers";
import SettingsUpdate from "./SettingsUpdate";

let harness: ReturnType<typeof makeApiHarness>;
const check = vi.fn<() => Promise<LinuxUpdateCheck>>();
const openUrl = vi.fn();
vi.mock("@/contexts", () => ({ useMainContext: () => ({ api: harness.api }) }));

const available: LinuxUpdateCheck = {
  kind: "package",
  status: "available",
  current: "1.0.0",
  latest: "v1.1.0",
  checkedAt: 1,
  url: "https://github.com/CateDesu/Nyastra-Mod-Manager/releases/tag/v1.1.0",
};

beforeEach(() => {
  harness = makeApiHarness({}, [
    { path: ["settings", "update"], reducer: settingsReducer },
    { path: ["session", "updater"], reducer: sessionReducer },
    { path: ["session", "notifications"], reducer: notificationsReducer },
  ]);
  const recordNotification = harness.api.sendNotification;
  harness.api.sendNotification = (notification) => {
    void harness.api.store.dispatch(addNotification(notification));
    return recordNotification(notification);
  };
  harness.api.dismissNotification = (id) => harness.api.store.dispatch(dismissNotification(id));
  check.mockReset().mockResolvedValue(available);
  openUrl.mockReset();
  vi.stubGlobal("api", {
    ...window.api,
    updates: { check },
    shell: { ...window.api.shell, openUrl },
  });
});
afterEach(() => {
  harness.api.dismissNotification("nyastra-update-available");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const renderSettings = () =>
  render(
    <Provider store={harness.api.store}>
      <SettingsUpdate />
    </Provider>,
  );

describe("automatic and manual update checks", () => {
  it("checks after startup, respects disabling, and stops its timers on cleanup", async () => {
    vi.useFakeTimers();
    const stop = startUpdateChecks(harness.api);
    await vi.advanceTimersByTimeAsync(9999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    harness.api.store.dispatch(setUpdateChannel("none"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(1);
    harness.api.store.dispatch(setUpdateChannel("stable"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping checks and avoids repeated notifications for the same update", async () => {
    let finish: (value: LinuxUpdateCheck) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = checkForUpdates(harness.api);
    expect(checkForUpdates(harness.api)).toBe(first);
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    expect(harness.api.getState().session.updater.checking).toBe(true);
    finish(available);
    await first;
    await checkForUpdates(harness.api);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.api.getState().session.updater.checking).toBe(false);
    const dismiss = vi.spyOn(harness.api, "dismissNotification");
    check.mockResolvedValueOnce({ ...available, status: "current" });
    await checkForUpdates(harness.api);
    expect(dismiss).toHaveBeenCalledWith("nyastra-update-available");
  });

  it.each(["no-release", "not-main", "local-history"] as const)(
    "removes the existing notification and its action when an update becomes unavailable: %s",
    async (reason) => {
      const update =
        reason === "no-release"
          ? available
          : {
              ...available,
              kind: "source" as const,
              url: "https://github.com/CateDesu/Nyastra-Mod-Manager/blob/main/docs/updater.md",
            };
      check.mockResolvedValueOnce(update);
      await checkForUpdates(harness.api);
      expect(harness.api.getState().session.notifications.notifications).toHaveLength(1);
      fireNotificationAction("nyastra-update-available", process.type, 0, () => undefined);
      expect(openUrl).toHaveBeenCalledWith(update.url);
      openUrl.mockClear();
      check.mockResolvedValueOnce({ ...update, status: "unavailable", reason });
      await checkForUpdates(harness.api);
      expect(harness.api.getState().session.notifications.notifications).toHaveLength(0);
      fireNotificationAction("nyastra-update-available", process.type, 0, () => undefined);
      expect(openUrl).not.toHaveBeenCalled();
    },
  );

  it("preserves the last confirmed update notice through a network failure", async () => {
    await checkForUpdates(harness.api);
    check.mockResolvedValueOnce({ ...available, status: "error" });
    await checkForUpdates(harness.api);
    expect(harness.api.getState().session.notifications.notifications).toHaveLength(1);
    fireNotificationAction("nyastra-update-available", process.type, 0, () => undefined);
    expect(openUrl).toHaveBeenCalledWith(available.url);
  });

  it("permits manual checks while automatic checking is off and recovers from IPC failures", async () => {
    harness.api.store.dispatch(setUpdateChannel("none"));
    check.mockRejectedValueOnce(new Error("disconnected"));
    renderSettings();
    await userEvent.click(screen.getByTestId("check-updates"));
    expect(screen.getByRole("status")).toHaveTextContent("Could not check for updates");
    expect(screen.getByTestId("check-updates")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("check-updates"));
    expect(screen.getByRole("status")).toHaveTextContent("An update is available");
    expect(harness.api.getState().settings.update.channel).toBe("none");
    await userEvent.click(screen.getByTestId("open-update"));
    expect(openUrl).toHaveBeenCalledWith(available.url);
  });

  it("saves the automatic preference through the real settings reducer and checks when enabled", async () => {
    renderSettings();
    const checkbox = screen.getByRole("checkbox", { name: "Automatically check for updates" });
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    await userEvent.click(checkbox);
    expect(harness.api.getState().settings.update.channel).toBe("none");
    expect(check).not.toHaveBeenCalled();
    await userEvent.click(checkbox);
    expect(harness.api.getState().settings.update.channel).toBe("stable");
    expect(check).toHaveBeenCalledOnce();
  });

  it("shows source instructions and preserves the warning about local changes", async () => {
    check.mockResolvedValueOnce({
      ...available,
      kind: "source",
      dirty: true,
      url: "https://github.com/CateDesu/Nyastra-Mod-Manager/blob/main/docs/updater.md",
    });
    renderSettings();
    await act(() => checkForUpdates(harness.api));
    expect(
      screen.getByText("This checkout has local changes. Save them before updating."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Update instructions" }));
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/CateDesu/Nyastra-Mod-Manager/blob/main/docs/updater.md",
    );
  });

  it("does not present an unpublished release channel as up to date", async () => {
    check.mockResolvedValueOnce({
      ...available,
      status: "unavailable",
      reason: "no-release",
      latest: undefined,
    });
    renderSettings();
    await act(() => checkForUpdates(harness.api));
    expect(screen.getByRole("status")).toHaveTextContent(
      "No compatible Linux release has been published yet.",
    );
    expect(harness.notifications).toHaveLength(0);
  });
});
