export const PROGRAM_NAME = "Nyastra's Mod Manager";
export const BRAND_NAME = "Nyastra's Mods";
export const SERVICE_NAME = "Nexus Mods";
export const PROFILE_NAME = "NyastraModManager";
export const REPOSITORY_URL = "https://github.com/CateDesu/Nyastra-Mod-Manager";
export const SUPPORT_URL: string = `${REPOSITORY_URL}/issues`;

const protectedTokens = String.raw`(?:[a-z][\w+.-]*:\/\/|www\.)[^\s<>"\]]+|(?:[a-z]:[\\/]|\/)[^\s<>"\]]+|\{\{[^}]*\}\}|\[[^\]]*\](?!\(|\[)|<[^>]*>|\x60[^\x60]*\x60`;
const names =
  /(?<![\w@./\\:])(?:Vortex|VORTEX|vortex)(?![\w/\\@]|\.[\w])(?:['’]s\b|['’](?=\s|$))?/g;

export function brandText(text: string, protectedValues: readonly string[] = []): string {
  if (!/vortex/i.test(text)) return text;

  const values = protectedValues
    .filter((value) => value.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tokens = new RegExp(`(${[...values, protectedTokens].join("|")})`, "gi");

  return text
    .split(tokens)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(names, (name) => PROGRAM_NAME + (name.length > 6 ? "'s" : "")),
    )
    .join("");
}
