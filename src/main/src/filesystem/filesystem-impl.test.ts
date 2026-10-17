import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VortexError } from "@vortex/shared";
import { QualifiedPath } from "@vortex/shared/filesystem";
import { NativePathResolver } from "@vortex/shared/filesystem";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeFileSystemBackendImpl } from "./backend";
import { NodeFileSystemImpl } from "./filesystem-impl";
import { PathResolverRegistryImpl } from "./path-resolver-registry";
import { nativeToQP } from "./testing";

describe("NodeFileSystemImpl", () => {
  let root: string;
  let rootQP: QualifiedPath;
  let fs: NodeFileSystemImpl;

  beforeEach(async () => {
    root = await nodeFs.mkdtemp(join(tmpdir(), "node-fs-"));
    rootQP = nativeToQP(root);
    fs = new NodeFileSystemImpl(
      new NodeFileSystemBackendImpl(),
      new PathResolverRegistryImpl([new NativePathResolver()]),
    );
  });

  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true, force: true });
  });

  it("writes and reads files through QualifiedPath", async () => {
    const target = rootQP.join("hello.txt");
    await fs.writeFile(target, new Uint8Array([1, 2, 3]));
    const bytes = await fs.readFile(target);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("stats existing files and reports missing ones", async () => {
    const target = rootQP.join("s.txt");
    await fs.writeFile(target, new Uint8Array([9]));
    const present = await fs.stat(target);
    assert(present.exists && present.isFile);
    expect(present.size).toBe(1);

    const missing = await fs.stat(rootQP.join("missing"));
    expect(missing.exists).toBe(false);
  });

  it("throws VortexError for missing files via readFile", async () => {
    await expect(fs.readFile(rootQP.join("nope"))).rejects.toBeInstanceOf(VortexError);
  });

  it("enumerates a directory yielding QualifiedPath entries", async () => {
    const files = ["a.txt", "b.txt", "c.txt"];
    await Promise.all(files.map((name) => nodeFs.writeFile(join(root, name), name)));

    const iter = await fs.enumerateDirectory(rootQP, { types: "files" });
    const seen: string[] = [];
    while (true) {
      const step = await iter.next();
      if (step.done) break;
      const qp = step.value;
      expect(qp).toBeInstanceOf(QualifiedPath);
      expect(qp.scheme).toBe("native");
      seen.push(qp.basename);
    }

    expect(seen.toSorted()).toEqual(files);
  });

  it("yields [QualifiedPath, Status] tuples when includeStatus is set", async () => {
    await nodeFs.writeFile(join(root, "x.txt"), "hi");
    const iter = await fs.enumerateDirectory(rootQP, {
      includeStatus: true,
      types: "files",
    });

    const step = await iter.next();
    assert(!step.done);

    expect(step.done).toBe(false);
    const [qp, status] = step.value;

    expect(qp).toBeInstanceOf(QualifiedPath);
    expect(qp.basename).toBe("x.txt");
    assert(status.isFile);
    expect(status.size).toBe(2);
    await iter.return?.(undefined);
  });

  it("rehydrates nested entries under the root QP when recursive", async () => {
    await nodeFs.mkdir(join(root, "sub"));
    await nodeFs.writeFile(join(root, "sub", "nested.txt"), "x");
    const iter = await fs.enumerateDirectory(rootQP, {
      recursive: true,
      types: "files",
    });
    const seen: string[] = [];
    while (true) {
      const step = await iter.next();
      if (step.done) break;
      seen.push(step.value.path);
    }
    expect(seen.some((p) => p.endsWith(`${rootQP.path}/sub/nested.txt`))).toBe(true);
  });

  it("enumerates names beginning with two dots inside the selected directory", async () => {
    await nodeFs.mkdir(join(root, "..cache"));
    await nodeFs.writeFile(join(root, "..cache", "data.txt"), "data");
    await nodeFs.writeFile(join(root, "..manifest.acf"), "manifest");
    const iterator = await fs.enumerateDirectory(rootQP, { recursive: true, types: "files" });
    const seen: string[] = [];
    try {
      for await (const entry of iterator) seen.push(entry.path);
    } finally {
      await iterator.return?.(undefined);
    }
    expect(seen.toSorted()).toEqual(
      [rootQP.join("..cache", "data.txt").path, rootQP.join("..manifest.acf").path].toSorted(),
    );
  });

  it("still rejects entries outside the selected directory", async () => {
    const backend = new NodeFileSystemBackendImpl();
    vi.spyOn(backend, "enumerateDirectory").mockResolvedValue({
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => Promise.resolve({ done: false, value: join(root, "..", "outside.txt") }),
      return: () => Promise.resolve({ done: true, value: undefined }),
    });
    const guarded = new NodeFileSystemImpl(
      backend,
      new PathResolverRegistryImpl([new NativePathResolver()]),
    );
    const iterator = await guarded.enumerateDirectory(rootQP);
    try {
      await expect(iterator.next()).rejects.toMatchObject({ data: { kind: "argument-invalid" } });
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it("closes the backend iterator when return() is called", async () => {
    for (const name of ["a", "b", "c"]) {
      await nodeFs.writeFile(join(root, name), name);
    }
    const iter = await fs.enumerateDirectory(rootQP, { types: "files" });
    await iter.next();
    await iter.return?.(undefined);
    // Closed iterators remain exhausted.
    const tail = await iter.next();
    expect(tail.done).toBe(true);
  });

  it.each(["complete", "early", "unread", "error"])(
    "releases the real directory handle after %s iteration",
    async (ending) => {
      const openHandles = async () => {
        const descriptors = await nodeFs.readdir("/proc/self/fd");
        const targets = await Promise.all(
          descriptors.map((fd) => nodeFs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
        );
        return targets.filter((target) => target === root).length;
      };
      if (ending === "error") await nodeFs.symlink("loop", join(root, "loop"));
      else await nodeFs.writeFile(join(root, "entry"), "data");
      const iterator = await fs.enumerateDirectory(rootQP, { includeStatus: true });
      try {
        expect(await openHandles()).toBe(1);
        if (ending === "error") {
          await expect(iterator.next()).rejects.toThrow();
        } else if (ending === "unread") {
          await iterator.return?.(undefined);
        } else if (ending === "early") {
          for await (const _entry of iterator) break;
        } else {
          for await (const _entry of iterator) {
            /* drain the directory */
          }
        }
        expect(await openHandles()).toBe(0);
        expect((await iterator.next()).done).toBe(true);
      } finally {
        await iterator.return?.(undefined);
      }
    },
  );

  it("rejects paths whose scheme has no registered resolver", async () => {
    const unknown = QualifiedPath.of({
      scheme: "steam",
      data: "",
      path: "SteamApps/common/Skyrim",
      root: "",
    });
    await expect(fs.readFile(unknown)).rejects.toThrow(/No resolver/);
  });
});
