import { describe, expect, it } from "vitest";

import { brandText, PROGRAM_NAME } from "./branding";

describe("display branding", () => {
  it("rebrands the program while retaining names for the actual service", () => {
    expect(brandText("Vortex downloads from Nexus Mods. Open NexusMods or Nexus.")).toBe(
      `${PROGRAM_NAME} downloads from Nexus Mods. Open NexusMods or Nexus.`,
    );
    expect(brandText("NEXUS MODS / Nexus-Mods / nexusmods")).toBe(
      "NEXUS MODS / Nexus-Mods / nexusmods",
    );
    expect(brandText("Vortex will now handle Nexus Mods download links")).toBe(
      `${PROGRAM_NAME} will now handle Nexus Mods download links`,
    );
  });

  it("preserves addresses, paths, markup attributes and internal identifiers", () => {
    const text =
      "https://github.com/Nexus-Mods/Vortex nxm://nexus/mods/1 /tmp/Vortex " +
      "C:\\Vortex\\mods nexus_integration @nexusmods/nexus-api Vortex.exe " +
      "[url=https://github.com/Nexus-Mods/Vortex]Nexus Mods[/url] " +
      '<a href="https://github.com/Nexus-Mods/Vortex">Vortex</a> `Nexus` {{Nexus}}';
    expect(brandText(text)).toBe(text.replace(">Vortex<", `>${PROGRAM_NAME}<`));
  });

  it("preserves user supplied names and is safe to apply more than once", () => {
    const branded = brandText("Nexus Mods: Vortex Hair Pack", ["Vortex Hair Pack"]);
    expect(branded).toBe("Nexus Mods: Vortex Hair Pack");
    expect(brandText(branded, ["Vortex Hair Pack"])).toBe(branded);
  });

  it("rebrands Markdown link labels while preserving their destinations", () => {
    const markdown =
      "Visit [Nexus Mods](https://www.nexusmods.com) or " +
      "[Vortex][program].\n\n[program]: https://github.com/Nexus-Mods/Vortex";
    expect(brandText(markdown)).toBe(
      "Visit [Nexus Mods](https://www.nexusmods.com) or " +
        `[${PROGRAM_NAME}][program].\n\n[program]: https://github.com/Nexus-Mods/Vortex`,
    );
  });

  it("handles possessives and names inside ordinary compound phrases", () => {
    expect(
      brandText("Nexus Mods' account, Nexus's servers and non-Nexus downloads. Vortex's settings."),
    ).toBe(
      "Nexus Mods' account, Nexus's servers and non-Nexus downloads. Nyastra's Mod Manager's settings.",
    );
  });
});
