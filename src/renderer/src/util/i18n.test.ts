import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { init } from "./i18n";

vi.mock("./getVortexPath", () => ({
  default: (key: string) =>
    path.resolve("../..", key === "locales" ? "locales" : "node_modules/.test-user-data"),
}));

describe("legacy translation plurals", () => {
  it("uses the bundled plural forms and keeps keys used directly", async () => {
    const { tFunc, error } = await init("en", () => []);

    expect(error).toBeUndefined();
    expect(tFunc("Do you really want to delete this archive?", { count: 2 })).toBe(
      "Do you really want to delete these 2 archives?",
    );
    expect(tFunc("{{ count }} minute ago", { count: 2 })).toBe("2 minutes ago");
    expect(tFunc("{{ count }} minute ago_plural", { count: 2 })).toBe("2 minutes ago");
  });

  it("supports legacy extension resources registered after startup", async () => {
    const { i18n } = await init("en", () => []);
    i18n.addResourceBundle("en", "test-extension", { item: "item", item_plural: "items" });

    const t = i18n.getFixedT("en", "test-extension");
    expect(t("item", { count: 2 })).toBe("items");
    i18n.addResourceBundle("en", "test-extension", { item_plural: "legacy updated" }, true, true);
    expect(t("item", { count: 2 })).toBe("legacy updated");
    i18n.addResources("en", "test-extension", { item_other: "modern items" });
    expect(t("item", { count: 2 })).toBe("modern items");
  });

  it("reuses the French legacy plural for both modern plural categories", async () => {
    const { i18n } = await init("en", () => []);
    i18n.addResourceBundle("fr", "test-extension", { item: "article", item_plural: "articles" });
    const t = i18n.getFixedT("fr", "test-extension");

    expect(t("item", { count: 1 })).toBe("article");
    expect(t("item", { count: 2 })).toBe("articles");
    expect(t("item", { count: 1_000_000 })).toBe("articles");
    i18n.addResource("fr", "test-extension", "item_many", "articles spéciaux");
    expect(t("item", { count: 1_000_000 })).toBe("articles spéciaux");
  });

  it("loads numbered plurals and preserves explicit modern forms", async () => {
    const { i18n } = await init("en", () => []);
    i18n.addResourceBundle("ru", "test-extension", {
      count_0: "one",
      count_1: "few",
      count_2: "legacy many",
      count_many: "modern many",
    });
    const t = i18n.getFixedT("ru", "test-extension");

    expect(t("count", { count: 21 })).toBe("one");
    expect(t("count", { count: 2 })).toBe("few");
    expect(t("count", { count: 5 })).toBe("modern many");
    expect(t("count_2")).toBe("legacy many");
  });
});
