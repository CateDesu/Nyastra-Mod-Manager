import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";

import { branding } from "./branding";

async function translator() {
  const instance = createInstance().use(branding);
  await instance.init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          login: "Log in to Nexus Mods",
          download: "Download {{mod.name}} from Nexus Mods: {{url}}",
          mods_one: "{{count}} Nexus mod",
          mods_other: "{{count}} Nexus mods",
          link: "[url=https://github.com/Nexus-Mods/Vortex]Nexus Mods[/url]",
        },
      },
      de: { translation: { login: "Bei Nexus Mods anmelden" } },
    },
    interpolation: { escapeValue: false },
    postProcess: [branding.name],
    postProcessPassResolved: true,
  });
  return instance;
}

describe("translated display branding", () => {
  it("covers translated, missing, default and plural strings without changing keys", async () => {
    const instance = await translator();
    expect(instance.t("login")).toBe("Log in to Nexus Mods");
    expect(instance.t("Handle Nexus Links")).toBe("Handle Nexus Links");
    expect(instance.t("new-key", { defaultValue: "Nexus Mods account" })).toBe(
      "Nexus Mods account",
    );
    expect(instance.t("mods", { count: 2 })).toBe("2 Nexus mods");
    expect(instance.getResource("en", "translation", "login")).toBe("Log in to Nexus Mods");
    await instance.changeLanguage("de");
    expect(instance.t("login")).toBe("Bei Nexus Mods anmelden");
  });

  it("preserves interpolated mod names and download URLs", async () => {
    const instance = await translator();
    const url = "nxm://nexus/mods/1/files/2";
    expect(instance.t("download", { replace: { mod: { name: "Nexus Hair Pack" }, url } })).toBe(
      `Download Nexus Hair Pack from Nexus Mods: ${url}`,
    );
    expect(instance.t("Install {{name}} with Vortex", { name: "Nexus Hair Pack" })).toBe(
      "Install Nexus Hair Pack with Nyastra's Mod Manager",
    );
    expect(instance.t("link")).toBe("[url=https://github.com/Nexus-Mods/Vortex]Nexus Mods[/url]");
  });
});
