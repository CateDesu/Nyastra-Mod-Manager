import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: "" }));
vi.mock("../../util/getVortexPath", () => ({ default: () => paths.root }));
vi.mock("../../util/errorHandling", async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  withTrackedActivity: async <T>(
    _tracer: string,
    _span: string,
    _attributes: unknown,
    run: () => Promise<T>,
  ) => run(),
}));

import { appReducer } from "../../reducers/app";
import { makeApiHarness, makeAvailableExtension } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { DataInvalid } from "../../util/CustomErrors";
import type * as ErrorHandling from "../../util/errorHandling";
import installExtension from "./installExtension";
import { findInstalled } from "./queries";

describe("extension installation filesystem boundaries", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nyastra-extension-"));
    paths.root = path.join(directory, "profile");
    await mkdir(path.join(paths.root, "plugins", "existing"), { recursive: true });
    await writeFile(path.join(paths.root, "settings.json"), "keep profile");
    await writeFile(path.join(paths.root, "plugins", "existing", "index.js"), "keep extension");
    vi.stubGlobal(
      "__non_webpack_require__",
      createRequire(path.join(process.cwd(), "package.json")),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  const archive = async (
    id: string | undefined,
    filename = "extension.zip",
    contents = "module.exports = () => true;",
  ) => {
    const source = await mkdtemp(path.join(directory, "source-"));
    await writeFile(path.join(source, "index.js"), contents);
    await writeFile(
      path.join(source, "info.json"),
      JSON.stringify({ id, name: "Fixture extension", version: "1.0.0" }),
    );
    const filenameOut = path.join(directory, filename);
    await new SevenZip().add(
      filenameOut,
      [path.join(source, "index.js"), path.join(source, "info.json")],
      {},
    );
    return filenameOut;
  };

  const makeApi = () => {
    const h = makeApiHarness({}, [{ path: ["app"], reducer: appReducer }]);
    h.api.getLoadedExtensions = () => [];
    return h;
  };

  for (const id of ["", ".", "..", "..zip", "...zip"]) {
    test(`rejects the reserved destination from extension id ${JSON.stringify(id)}`, async () => {
      const h = makeApi();
      const filePath = await archive(id);
      const error = await installExtension(h.api, filePath).catch((err: unknown) => err);
      expect(await readFile(path.join(paths.root, "settings.json"), "utf8")).toBe("keep profile");
      expect(await readFile(path.join(paths.root, "plugins", "existing", "index.js"), "utf8")).toBe(
        "keep extension",
      );
      expect(error).toBeInstanceOf(DataInvalid);
      expect(h.getState().app.extensions).toEqual({});
    });
  }

  test("rejects an archive-name fallback that resolves to the plugins directory", async () => {
    const h = makeApi();
    const filePath = await archive(undefined, "..zip");
    const error = await installExtension(h.api, filePath).catch((err: unknown) => err);
    expect(await readFile(path.join(paths.root, "plugins", "existing", "index.js"), "utf8")).toBe(
      "keep extension",
    );
    expect(error).toBeInstanceOf(DataInvalid);
  });

  for (const id of [undefined, "fixture", "..fixture"]) {
    test(`installs a valid archive with id ${JSON.stringify(id)} beside existing data`, async () => {
      const h = makeApi();
      await installExtension(h.api, await archive(id));
      const destination = path.join(paths.root, "plugins", id ?? "extension");
      expect(await readFile(path.join(destination, "index.js"), "utf8")).toBe(
        "module.exports = () => true;",
      );
      expect(await readFile(path.join(paths.root, "plugins", "existing", "index.js"), "utf8")).toBe(
        "keep extension",
      );
      expect(
        Object.values(h.getState().app.extensions).some((ext) => ext.path === destination),
      ).toBe(true);
    });
  }

  test("installs both case-distinct archives dropped together", async () => {
    const h = makeApi();
    const upperContents = "module.exports = () => 'upper';";
    const lowerContents = "module.exports = () => 'lower';";
    const upperArchive = await archive("Upper", "Fixture.zip", upperContents);
    const lowerArchive = await archive("Lower", "fixture.zip", lowerContents);

    await Promise.all([
      installExtension(h.api, upperArchive),
      installExtension(h.api, lowerArchive),
    ]);

    expect(
      Object.values(h.getState().app.extensions)
        .map((entry) => path.basename(entry.path))
        .sort(),
    ).toEqual(["Lower", "Upper"]);
    expect(await readFile(path.join(paths.root, "plugins", "Upper", "index.js"), "utf8")).toBe(
      upperContents,
    );
    expect(await readFile(path.join(paths.root, "plugins", "Lower", "index.js"), "utf8")).toBe(
      lowerContents,
    );
  });

  test("coalesces concurrent requests for the same archive", async () => {
    const h = makeApi();
    const file = await archive("fixture");
    const first = installExtension(h.api, file);
    const second = installExtension(h.api, file);

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(Object.values(h.getState().app.extensions)).toHaveLength(1);
    expect(await readFile(path.join(paths.root, "plugins", "fixture", "index.js"), "utf8")).toBe(
      "module.exports = () => true;",
    );
  });

  test("keeps a case-distinct old version marked for removal after updating", async () => {
    const h = makeApi();
    const oldPath = path.join(paths.root, "plugins", "Fixture");
    const newPath = path.join(paths.root, "plugins", "fixture");
    await installExtension(h.api, await archive("Fixture", "old.zip"), {
      catalogEntry: makeAvailableExtension({ modId: 123, fileId: 1, version: "1.0.0" }),
    });
    const oldEntry = findInstalled(h.getState().app.extensions, { path: oldPath });
    expect(oldEntry).toBeDefined();

    await installExtension(h.api, await archive("fixture", "new.zip"), {
      catalogEntry: makeAvailableExtension({ modId: 123, fileId: 2, version: "2.0.0" }),
    });

    expect(await readFile(path.join(oldPath, "index.js"), "utf8")).toBe(
      "module.exports = () => true;",
    );
    expect(await readFile(path.join(newPath, "index.js"), "utf8")).toBe(
      "module.exports = () => true;",
    );
    expect((await stat(oldPath)).ino).not.toBe((await stat(newPath)).ino);
    const extensions = h.getState().app.extensions;
    expect(extensions[oldEntry!.key]).toMatchObject({ path: oldPath, remove: true });
    expect(findInstalled(extensions, { path: newPath })?.extension).toMatchObject({
      path: newPath,
      remove: false,
      version: "2.0.0",
    });
  });

  test("clears the old removal entry when an update replaces the same directory", async () => {
    const h = makeApi();
    const destination = path.join(paths.root, "plugins", "Fixture");
    await installExtension(h.api, await archive("Fixture", "old.zip"), {
      catalogEntry: makeAvailableExtension({ modId: 123, fileId: 1, version: "1.0.0" }),
    });
    await installExtension(h.api, await archive("Fixture", "new.zip"), {
      catalogEntry: makeAvailableExtension({ modId: 123, fileId: 2, version: "2.0.0" }),
    });

    expect(Object.values(h.getState().app.extensions)).toEqual([
      expect.objectContaining({ path: destination, remove: false, version: "2.0.0" }),
    ]);
    expect(await readFile(path.join(destination, "index.js"), "utf8")).toBe(
      "module.exports = () => true;",
    );
  });
});
