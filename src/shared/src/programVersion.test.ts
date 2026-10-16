import { describe, expect, it } from "vitest";

import { formatProgramVersion, packageVersionFromRelease } from "./programVersion";

describe("program release numbering", () => {
  it.each([0, 1, 9, 10, 99, 100, 999])("round trips release number %s", (number) => {
    const version = `2.9.${number}`;
    const display = `1.${String(number).padStart(2, "0")}`;
    expect(formatProgramVersion(version)).toBe(display);
    expect(packageVersionFromRelease(display)).toBe(version);
    expect(packageVersionFromRelease(`v${display}`)).toBe(version);
  });

  it.each(["2.9.0-beta.2+linux.3", "2.9.1000", "2.9.01", "3.0.0"])(
    "preserves versions outside the numbered release sequence: %s",
    (version) => expect(formatProgramVersion(version)).toBe(version),
  );

  it.each(["v1.001", "v1.1000", "1.0.0", "v2.9.0-beta.2+linux.3"])(
    "does not reinterpret other version formats: %s",
    (version) => expect(packageVersionFromRelease(version)).toBe(version),
  );
});
