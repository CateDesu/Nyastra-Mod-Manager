import type { IExtensionContext } from "@/types/IExtensionContext";

import settingsReducer from "./reducers/settings.reducer";
import SettingsAnalytics from "./views/SettingsAnalytics";

function init(context: IExtensionContext): boolean {
  context.registerReducer(["settings", "analytics"], settingsReducer);
  context.registerSettings("Vortex", SettingsAnalytics, undefined, undefined, 110);
  return true;
}

export default init;
