import type { TFunction } from "i18next";

function getText(id: string, t: TFunction): string {
  switch (id) {
    case "chrome-fix":
      return t(
        "Older versions of Chrome could save a setting that blocks nxm:// download links. " +
          "This repair clears that setting in the last used Chrome profile. Close all Chrome " +
          "windows before applying it so Chrome does not overwrite the change.\n\n" +
          "Current Chrome versions use a permission prompt instead. Click a Mod Manager Download " +
          "button on Nexus Mods and allow Chrome to open Nyastra's Mod Manager. " +
          "If the older setting is absent, this repair leaves your preferences unchanged.\n",
      );
    default:
      return undefined;
  }
}

export default getText;
