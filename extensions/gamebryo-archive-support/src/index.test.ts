import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { finished } from "node:stream/promises";

import { fs, type types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BSAArchive, BSAWriter } from "./bsa";
import init from "./index";

const fixtures = path.resolve(__dirname, "../test-data");
type TmpCallback = (error: Error | null, name: string) => void;
const tmp: {
  dir: (options: { tmpdir: string } | TmpCallback, callback?: TmpCallback) => void;
} = require("tmp");
const allocateDirectory = tmp.dir;
const extractFile = Object.getOwnPropertyDescriptors(BSAArchive.prototype).extractFile.value;
const createReadStream = fs.createReadStream;
const temporaryPaths = new Set<string>();
const streams = new Set<Readable>();
const allocations: Promise<void>[] = [];
const extractions: Promise<void>[] = [];
const releases: (() => void)[] = [];
let directory: string;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Archive test operation timed out")), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function track<T extends Readable>(stream: T): T {
  streams.add(stream);
  stream.on("error", () => undefined);
  return stream;
}

function read(archive: types.IArchiveHandler, name: string): Readable {
  const stream = archive.readFile(name);
  if (!(stream instanceof Readable)) throw new Error("Expected a readable BSA stream");
  return track(stream);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nyastra-bsa-handlers-"));
  vi.spyOn(tmp, "dir").mockImplementation((callback) => {
    if (typeof callback !== "function") throw new Error("Expected a temporary directory callback");
    let complete!: () => void;
    allocations.push(new Promise<void>((resolve) => (complete = resolve)));
    allocateDirectory({ tmpdir: directory }, (error, name) => {
      try {
        if (error === null) temporaryPaths.add(name);
        callback(error, name);
      } finally {
        complete();
      }
    });
  });
  vi.spyOn(BSAArchive.prototype, "extractFile").mockImplementation(function (file, output) {
    const operation = extractFile.call(this, file, output);
    extractions.push(operation);
    return operation;
  });
  vi.spyOn(fs, "createReadStream").mockImplementation((...args) =>
    track(createReadStream(...args)),
  );
});

afterEach(async () => {
  try {
    releases.splice(0).forEach((release) => release());
    for (const stream of streams) stream.destroy();
    await bounded(Promise.allSettled(allocations));
    await bounded(Promise.allSettled(extractions));
    for (const stream of streams) stream.destroy();
    await bounded(
      Promise.allSettled([...streams].map((stream) => finished(stream, { cleanup: true }))),
    );
    await bounded(
      Promise.all(
        [...streams].map((stream) => (stream.closed ? undefined : once(stream, "close"))),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      vi.restoreAllMocks();
      vi.clearAllMocks();
      temporaryPaths.clear();
      streams.clear();
      allocations.length = 0;
      extractions.length = 0;
    }
  }
});

async function expectRemoved(count = 1) {
  await vi.waitFor(() => expect(fs.removeAsync).toHaveBeenCalledTimes(count), { timeout: 1000 });
  expect(temporaryPaths.size).toBe(count);
  expect(new Set(vi.mocked(fs.removeAsync).mock.calls.map(([target]) => target))).toEqual(
    temporaryPaths,
  );
  await vi.waitFor(
    async () => {
      for (const target of temporaryPaths) {
        await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    { timeout: 1000 },
  );
}

async function openArchive(extension: string, name: string, options: types.IArchiveOptions = {}) {
  const registerArchiveType = vi.fn<types.IExtensionContext["registerArchiveType"]>();
  init({ registerArchiveType } as unknown as types.IExtensionContext);
  const create = registerArchiveType.mock.calls.find(([type]) => type === extension)![1];
  return await create(path.resolve(fixtures, name), options);
}

it("lists the BA2 root and nested directories", async () => {
  const archive = await openArchive("ba2", "test-gnrl.ba2");
  expect(await archive.readDir("")).toEqual(["meshes", "scripts", "materials"]);
  expect(await archive.readDir("meshes")).toEqual(["weapon"]);
  expect(await archive.readDir("MESHES/WEAPON/")).toEqual(["gun.nif"]);
  expect(await archive.readDir("mesh")).toEqual([]);
});

it("streams a BSA file using its archive name and removes its temporary directory", async () => {
  const archive = await openArchive("bsa", "test-v104.bsa");
  const expected = JSON.parse(await readFile(path.join(fixtures, "expected-bsa.json"), "utf8"));
  const stream = read(archive, "MESHES\\WEAPONS\\SWORD.NIF");
  expect((await bounded(buffer(stream))).toString()).toBe(
    expected.v104.files["meshes\\weapons\\sword.nif"],
  );
  expect(fs.createReadStream).toHaveBeenCalledTimes(1);
  await expectRemoved();
}, 3000);

it("does not open a source after cancellation during real extraction", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  releases.push(release);
  let extracted = false;
  vi.spyOn(BSAArchive.prototype, "extractFile").mockImplementationOnce(function (file, output) {
    const operation = extractFile.call(this, file, output).then(() => {
      extracted = true;
      return gate;
    });
    extractions.push(operation);
    return operation;
  });
  const archive = await openArchive("bsa", "test-v104.bsa");
  const stream = read(archive, "meshes/weapons/sword.nif");
  const onError = vi.fn<(error: Error) => void>();
  stream.on("error", onError);
  await vi.waitFor(() => expect(extracted).toBe(true), { timeout: 1000 });
  expect(fs.createReadStream).not.toHaveBeenCalled();
  const closed = once(stream, "close");
  stream.destroy();
  await bounded(closed);
  release();
  await bounded(Promise.all(extractions));
  await expectRemoved();
  expect(fs.createReadStream).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
}, 4000);

it("closes an active backpressured BSA source when its consumer cancels", async () => {
  const input = path.join(directory, "source.bin");
  await writeFile(input, Buffer.alloc(4 * 1024 * 1024, 0x61));
  const archivePath = path.join(directory, "input.bsa");
  const writer = new BSAWriter(archivePath, 0x68);
  writer.addFile("data\\large.bin", input);
  await writer.write();
  const archive = await openArchive("bsa", archivePath);
  const stream = read(archive, "DATA/LARGE.BIN");
  await bounded(once(stream, "readable"));
  expect(fs.createReadStream).toHaveBeenCalledTimes(1);
  const source = vi.mocked(fs.createReadStream).mock.results[0].value;
  expect(source.bytesRead).toBeGreaterThan(0);
  expect(source.readableEnded).toBe(false);
  expect(source.destroyed).toBe(false);
  expect(stream.readableLength).toBeGreaterThanOrEqual(stream.readableHighWaterMark);
  const closed = once(stream, "close");
  stream.destroy();
  await bounded(closed);
  await vi.waitFor(
    () => {
      expect(source.destroyed).toBe(true);
      expect(source.closed).toBe(true);
    },
    { timeout: 1000 },
  );
  await expectRemoved();
}, 4000);

it("keeps concurrent BSA reads and their temporary directories separate", async () => {
  const archive = await openArchive("bsa", "test-v104.bsa");
  const expected = JSON.parse(await readFile(path.join(fixtures, "expected-bsa.json"), "utf8"));
  const names = ["meshes/weapons/sword.nif", "scripts/quest/main.pex"];
  const data = await bounded(Promise.all(names.map((name) => buffer(read(archive, name)))));
  expect(data.map((entry) => entry.toString())).toEqual(
    names.map((name) => expected.v104.files[name.replaceAll("/", "\\")]),
  );
  await expectRemoved(2);
}, 3000);

it("reports a missing BSA member through the returned stream", async () => {
  const archive = await openArchive("bsa", "test-v104.bsa");
  const stream = read(archive, "missing.nif");
  await expect(bounded(buffer(stream))).rejects.toThrow("file not found missing.nif");
  expect(fs.removeAsync).not.toHaveBeenCalled();
});

it("reports reads from a BSA writer through the returned stream", async () => {
  const archive = await openArchive("bsa", "unused.bsa", { create: true });
  await expect(bounded(buffer(read(archive, "file.nif")))).rejects.toThrow(
    "Archive opened in create mode",
  );
  expect(fs.removeAsync).not.toHaveBeenCalled();
});

it("removes extracted files when the BSA source stream fails", async () => {
  const archive = await openArchive("bsa", "test-v104.bsa");
  vi.mocked(fs.createReadStream).mockImplementationOnce(() =>
    track(createReadStream(path.join(directory, "missing-file"))),
  );
  await expect(bounded(buffer(read(archive, "meshes/weapons/sword.nif")))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expectRemoved();
}, 3000);

it("removes temporary extraction files after a BSA read fails", async () => {
  const source = path.join(directory, "input.bsa");
  await copyFile(path.join(fixtures, "test-v104.bsa"), source);
  const archive = await openArchive("bsa", source);
  await rm(source);
  const stream = read(archive, "meshes/weapons/sword.nif");
  await expect(bounded(buffer(stream))).rejects.toMatchObject({ code: "ENOENT" });
  await expectRemoved();
}, 3000);
