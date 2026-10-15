import { REPOSITORY_URL } from "@vortex/shared";

import type { IExtensionApi } from "../../types/IExtensionContext";
import { setLinuxUpdateCheck, setUpdateChecking } from "./actions";

const pending = new WeakMap<IExtensionApi, Promise<void>>();

export function checkForUpdates(api: IExtensionApi): Promise<void> {
  const existing = pending.get(api);
  if (existing) return existing;
  api.store.dispatch(setUpdateChecking(true));
  const check = Promise.resolve()
    .then(() => window.api.updates.check())
    .then((result) => {
      const previous = api.getState().session.updater?.check;
      api.store.dispatch(setLinuxUpdateCheck(result));
      if (result.status === "current" || result.status === "unavailable") {
        api.dismissNotification("nyastra-update-available");
      }
      if (
        result.status === "available" &&
        (previous?.status !== "available" || previous.latest !== result.latest)
      ) {
        api.sendNotification({
          id: "nyastra-update-available",
          type: "info",
          title: "Nyastra update available",
          message:
            result.kind === "source"
              ? "New source changes are available on main."
              : "A new Linux release is available.",
          actions: [
            {
              title: result.kind === "source" ? "Update instructions" : "Open release",
              action: () => {
                window.api.shell.openUrl(result.url);
              },
            },
          ],
        });
      }
    })
    .catch(() => {
      const previous = api.getState().session.updater?.check;
      api.store.dispatch(
        setLinuxUpdateCheck({
          kind: previous?.kind ?? "package",
          status: "error",
          current: previous?.current ?? "",
          checkedAt: Date.now(),
          url: previous?.url ?? `${REPOSITORY_URL}/releases`,
        }),
      );
    })
    .finally(() => {
      api.store.dispatch(setUpdateChecking(false));
      pending.delete(api);
    });
  pending.set(api, check);
  return check;
}

export function startUpdateChecks(api: IExtensionApi): () => void {
  const check = () => {
    if (api.getState().settings.update?.channel !== "none") void checkForUpdates(api);
  };
  const startup = setTimeout(check, 10_000);
  const repeat = setInterval(check, 6 * 60 * 60 * 1000);
  return () => {
    clearTimeout(startup);
    clearInterval(repeat);
  };
}
