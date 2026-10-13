import type { IExtensionContext } from "../../types/IExtensionContext";
import settingsReducer, { sessionReducer } from "./reducers";
import SettingsUpdate from "./SettingsUpdate";

export default function init(context: IExtensionContext): boolean {
  context.registerReducer(["settings", "update"], settingsReducer);
  context.registerReducer(["session", "updater"], sessionReducer);
  context.registerSettings("Vortex", SettingsUpdate);
  return true;
}
