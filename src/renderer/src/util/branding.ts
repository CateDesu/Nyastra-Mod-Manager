import { brandText } from "@vortex/shared";
import type { PostProcessorModule } from "i18next";

export const branding: PostProcessorModule = {
  name: "nyastraBranding",
  type: "postProcessor",
  process(value, keys, options) {
    const resolved = options.i18nResolved as { res?: unknown } | undefined;
    const templates = [resolved?.res, options.defaultValue, ...keys];
    const data = options.replace ?? options;
    const protectedValues: string[] = [];

    for (const template of templates) {
      if (typeof template !== "string") continue;
      for (const match of template.matchAll(/\{\{-?\s*([^},]+)(?:,[^}]*)?\}\}/g)) {
        const replacement = match[1]
          .trim()
          .split(".")
          .reduce<unknown>(
            (current, key) =>
              current !== null && typeof current === "object"
                ? (current as Record<string, unknown>)[key]
                : undefined,
            data,
          );
        if (typeof replacement === "string") protectedValues.push(replacement);
      }
    }

    return brandText(value, protectedValues);
  },
};
