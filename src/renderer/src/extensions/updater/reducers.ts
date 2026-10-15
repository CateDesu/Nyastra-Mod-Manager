import type { LinuxUpdateCheck, UpdaterSnapshot } from "@vortex/shared/ipc";
import update from "immutability-helper";

import type { IReducerSpec } from "../../types/IExtensionContext";
import {
  setLinuxUpdateCheck,
  setUpdateChecking,
  setUpdateChannel,
  setUpdaterSnapshot,
} from "./actions";

export interface IUpdaterSessionState {
  snapshot?: UpdaterSnapshot;
  check?: LinuxUpdateCheck;
  checking?: boolean;
}

export const sessionReducer: IReducerSpec = {
  reducers: {
    [setLinuxUpdateCheck as any]: (state, payload) => ({ ...state, check: payload }),
    [setUpdateChecking as any]: (state, payload) => ({ ...state, checking: payload }),
    [setUpdaterSnapshot as any]: (state, payload) => update(state, { snapshot: { $set: payload } }),
  },
  defaults: {} satisfies IUpdaterSessionState,
};

const settingsReducer: IReducerSpec = {
  reducers: {
    [setUpdateChannel as any]: (state, payload) => update(state, { channel: { $set: payload } }),
  },
  defaults: {
    channel: "stable",
  },
};

export default settingsReducer;
