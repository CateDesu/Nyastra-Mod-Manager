import type { LinuxUpdateCheck, UpdaterSnapshot } from "@vortex/shared/ipc";

import safeCreateAction from "../../actions/safeCreateAction";

/** The persisted "none" channel disables automatic checks. */
export const setUpdateChannel = safeCreateAction("SET_UPDATE_CHANNEL", (channel) => channel);

export const setLinuxUpdateCheck = safeCreateAction(
  "SET_LINUX_UPDATE_CHECK",
  (result: LinuxUpdateCheck) => result,
);
export const setUpdateChecking = safeCreateAction(
  "SET_UPDATE_CHECKING",
  (checking: boolean) => checking,
);

export const setUpdaterSnapshot = safeCreateAction(
  "SET_UPDATER_SNAPSHOT",
  (snapshot: UpdaterSnapshot) => snapshot,
);
