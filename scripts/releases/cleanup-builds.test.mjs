import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanupGithubBuilds, githubRequest, pruneLocalBuilds } from "./cleanup-builds.mjs";

const prefix = "/repos/CateDesu/Nyastra-Mod-Manager";
const version = "3.0.0-beta.2+linux.10";
const buildNames = (v, arch = "x64") =>
  ["zip", "AppImage", "deb"].map((ext) => `nyastra-${v}-linux-${arch}.${ext}`);
const assets = (v, start, arch) =>
  buildNames(v, arch).map((name, index) => ({
    id: start + index,
    name,
    state: "uploaded",
    size: 10,
  }));
const release = (id, tag, prerelease = false) => ({
  id,
  tag_name: `v${tag}`,
  prerelease,
  draft: false,
});
const artifact = (id, extra = {}) => ({
  id,
  name: "nyastra-linux-preview",
  size_in_bytes: 100,
  expired: false,
  created_at: `2026-10-${String(id).padStart(2, "0")}T00:00:00Z`,
  workflow_run: { id, head_branch: "main" },
  ...extra,
});
const completed = {
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  path: ".github/workflows/package-linux.yml",
};

async function github(t, routes = {}) {
  const calls = [];
  const responses = {
    "/releases?per_page=100&page=1": [],
    "/actions/artifacts?per_page=100&page=1": { artifacts: [] },
    ...routes,
  };
  const server = createServer((request, response) => {
    calls.push([request.method, request.url]);
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    assert.equal(request.headers["x-github-api-version"], "2026-03-10");
    const route = request.url.slice(prefix.length);
    const result = responses[`${request.method} ${route}`] ?? responses[route];
    if (!request.url.startsWith(prefix) || (result === undefined && request.method !== "DELETE")) {
      response.writeHead(500).end();
    } else if (result?.httpStatus) {
      response.writeHead(result.httpStatus).end();
    } else if (request.method === "DELETE") {
      response.writeHead(204).end();
    } else {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    request: githubRequest("fixture-token", `http://127.0.0.1:${server.address().port}`),
    responses,
    calls,
    deleted: () =>
      calls.filter(([method]) => method === "DELETE").map(([, url]) => url.slice(prefix.length)),
  };
}

test("release cleanup retains the highest complete stable and preview builds", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": [
      release(1, "2.0.0"),
      release(2, "3.0.0"),
      release(3, "4.0.0-beta.1", true),
      release(4, "4.0.0-beta.2", true),
    ],
    "/releases/1/assets?per_page=100&page=1": [
      ...assets("2.0.0", 10),
      { id: 19, name: "license.txt", size: 10, state: "uploaded" },
    ],
    "/releases/2/assets?per_page=100&page=1": assets("3.0.0", 20),
    "/releases/3/assets?per_page=100&page=1": assets("4.0.0-beta.1", 30),
    "/releases/4/assets?per_page=100&page=1": assets("4.0.0-beta.2", 40),
  });
  assert.deepEqual(await cleanupGithubBuilds(f.request, { releaseId: 4 }), {
    releaseAssets: 6,
    artifacts: 0,
  });
  assert.deepEqual(
    f.deleted(),
    [10, 11, 12, 30, 31, 32].map((id) => `/releases/assets/${id}`),
  );
});

test("short filenames and compatibility ZIPs follow numeric release ordering", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": [release(1, "2.9.99"), release(2, "2.9.100")],
    "/releases/1/assets?per_page=100&page=1": [
      ...assets("1.99", 10),
      { ...assets("2.9.99", 13)[0] },
    ],
    "/releases/2/assets?per_page=100&page=1": [
      ...assets("1.100", 20),
      { ...assets("2.9.100", 23)[0] },
    ],
  });
  assert.equal((await cleanupGithubBuilds(f.request, { releaseId: 2 })).releaseAssets, 4);
  assert.deepEqual(
    f.deleted(),
    [10, 11, 12, 13].map((id) => `/releases/assets/${id}`),
  );
});

test("build metadata ordering and architecture retention match package updates", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": [release(1, "3.0.0-beta.2+linux.2"), release(2, version)],
    "/releases/1/assets?per_page=100&page=1": [
      ...assets("3.0.0-beta.2+linux.2", 10),
      ...assets("3.0.0-beta.2+linux.2", 13, "arm64"),
    ],
    "/releases/2/assets?per_page=100&page=1": assets(version, 20),
  });
  await cleanupGithubBuilds(f.request);
  assert.deepEqual(
    f.deleted(),
    [10, 11, 12].map((id) => `/releases/assets/${id}`),
  );
});

test("incomplete published builds stop all deletion", async (t) => {
  for (const missing of ["zip", "AppImage", "deb"]) {
    const f = await github(t, {
      "/releases?per_page=100&page=1": [release(1, "2.0.0"), release(2, "3.0.0")],
      "/releases/1/assets?per_page=100&page=1": assets("2.0.0", 10),
      "/releases/2/assets?per_page=100&page=1": assets("3.0.0", 20).filter(
        (asset) => !asset.name.endsWith(`.${missing}`),
      ),
    });
    await assert.rejects(cleanupGithubBuilds(f.request, { releaseId: 2 }), /before cleanup/);
    assert.deepEqual(f.deleted(), []);
  }
});

test("draft, empty and still uploading assets cannot replace published builds", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": [
      release(1, "2.0.0"),
      release(2, "3.0.0"),
      { ...release(3, "4.0.0"), draft: true },
    ],
    "/releases/1/assets?per_page=100&page=1": assets("2.0.0", 10),
    "/releases/2/assets?per_page=100&page=1": assets("3.0.0", 20).map((asset, index) =>
      index ? asset : { ...asset, size: 0, state: "starter" },
    ),
  });
  await cleanupGithubBuilds(f.request);
  assert.deepEqual(f.deleted(), []);
  assert.ok(!f.calls.some(([, url]) => url.includes("/releases/3/")));
});

test("all release, asset and artifact pages are read before deletion", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": Array.from({ length: 100 }, (_, id) =>
      release(id + 100, "not-a-version"),
    ),
    "/releases?per_page=100&page=2": [release(1, "2.0.0"), release(2, "3.0.0")],
    "/releases/1/assets?per_page=100&page=1": Array.from({ length: 100 }, (_, id) => ({
      id: id + 100,
      name: `notes-${id}.txt`,
      size: 1,
      state: "uploaded",
    })),
    "/releases/1/assets?per_page=100&page=2": assets("2.0.0", 10),
    "/releases/2/assets?per_page=100&page=1": assets("3.0.0", 20),
    "/actions/artifacts?per_page=100&page=1": {
      artifacts: Array.from({ length: 100 }, (_, id) => ({ id: id + 100, name: "unrelated" })),
    },
    "/actions/artifacts?per_page=100&page=2": { artifacts: [artifact(1), artifact(2)] },
    "/actions/runs/2": completed,
  });
  assert.deepEqual(await cleanupGithubBuilds(f.request), { releaseAssets: 3, artifacts: 1 });
  assert.deepEqual(f.deleted(), [
    "/releases/assets/10",
    "/releases/assets/11",
    "/releases/assets/12",
    "/actions/artifacts/1",
  ]);
  assert.equal(f.calls.at(-5)[0], "GET");
});

test("a later read failure prevents even already planned deletions", async (t) => {
  const f = await github(t, {
    "/releases?per_page=100&page=1": [release(1, "2.0.0"), release(2, "3.0.0")],
    "/releases/1/assets?per_page=100&page=1": assets("2.0.0", 10),
    "/releases/2/assets?per_page=100&page=1": assets("3.0.0", 20),
    "/actions/artifacts?per_page=100&page=1": { httpStatus: 403 },
  });
  await assert.rejects(cleanupGithubBuilds(f.request), /HTTP 403/);
  assert.deepEqual(f.deleted(), []);
});

test("artifact cleanup requires a successful packaging run and retains newer unfinished builds", async (t) => {
  const f = await github(t, {
    "/actions/artifacts?per_page=100&page=1": {
      artifacts: [artifact(1), artifact(2), artifact(3), artifact(4), { id: 5, name: "unrelated" }],
    },
    "/actions/runs/4": { ...completed, status: "in_progress", conclusion: null },
    "/actions/runs/3": { ...completed, path: ".github/workflows/unrelated.yml" },
    "/actions/runs/2": completed,
  });
  assert.deepEqual(await cleanupGithubBuilds(f.request, { artifactsOnly: true }), {
    releaseAssets: 0,
    artifacts: 1,
  });
  assert.deepEqual(f.deleted(), ["/actions/artifacts/1"]);
  assert.ok(!f.calls.some(([, url]) => url.includes("/releases")));
});

test("expired, empty and non-main artifacts do not qualify as replacements", async (t) => {
  const f = await github(t, {
    "/actions/artifacts?per_page=100&page=1": {
      artifacts: [
        artifact(1, { expired: true }),
        artifact(2, { size_in_bytes: 0 }),
        artifact(3, { workflow_run: { id: 3, head_branch: "test" } }),
      ],
    },
  });
  await cleanupGithubBuilds(f.request, { artifactsOnly: true });
  assert.deepEqual(f.deleted(), []);
});

test("invalid metadata prevents cleanup", async (t) => {
  for (const bad of [
    { id: "1" },
    { created_at: "invalid" },
    { size_in_bytes: -1 },
    { workflow_run: null },
  ]) {
    const f = await github(t, {
      "/actions/artifacts?per_page=100&page=1": { artifacts: [artifact(1, bad)] },
    });
    await assert.rejects(cleanupGithubBuilds(f.request));
    assert.deepEqual(f.deleted(), []);
  }
});

test("deletion failures stop cleanup and already deleted artifacts can be retried", async (t) => {
  const f = await github(t, {
    "/actions/artifacts?per_page=100&page=1": {
      artifacts: [artifact(1), artifact(2), artifact(3)],
    },
    "/actions/runs/3": completed,
    "DELETE /actions/artifacts/2": { httpStatus: 403 },
  });
  await assert.rejects(cleanupGithubBuilds(f.request, { artifactsOnly: true }), /HTTP 403/);
  assert.deepEqual(f.deleted(), ["/actions/artifacts/2"]);
  f.responses["DELETE /actions/artifacts/2"] = { httpStatus: 404 };
  await cleanupGithubBuilds(f.request, { artifactsOnly: true });
  assert.equal(f.deleted().at(-1), "/actions/artifacts/1");
});

async function local(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-build-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (names, content = "build") => {
    for (const name of names) await writeFile(path.join(directory, name), content);
  };
  return { directory, put };
}

test("local cleanup removes only older matching builds after all replacement formats exist", async (t) => {
  const f = await local(t);
  const previous = buildNames("3.0.0-beta.2+linux.2");
  await f.put([...previous, `${previous[0]}.blockmap`, ...buildNames(version)]);
  const retained = ["personal.zip", ...buildNames("4.0.0"), ...buildNames("2.0.0", "arm64")];
  await f.put(retained);
  await mkdir(path.join(f.directory, "nyastra-1.0.0-linux-x64.zip"));
  assert.equal(await pruneLocalBuilds(f.directory, version, "x64"), 4);
  assert.deepEqual(
    (await readdir(f.directory)).sort(),
    [...retained, ...buildNames(version), "nyastra-1.0.0-linux-x64.zip"].sort(),
  );
});

test("local cleanup orders short filenames after earlier previews and release numbers", async (t) => {
  const f = await local(t);
  await f.put([
    ...buildNames("2.9.0-beta.2+linux.3"),
    ...buildNames("1.99"),
    ...buildNames("1.100"),
  ]);
  assert.equal(await pruneLocalBuilds(f.directory, "2.9.100", "x64"), 6);
  assert.deepEqual((await readdir(f.directory)).sort(), buildNames("1.100").sort());
});

test("missing and empty replacement outputs preserve all previous builds", async (t) => {
  const f = await local(t);
  const previous = buildNames("2.0.0");
  await f.put(previous);
  await f.put(buildNames(version).slice(0, 2));
  assert.equal(await pruneLocalBuilds(f.directory, version, "x64"), 0);
  await f.put(buildNames(version).slice(2), "");
  assert.equal(await pruneLocalBuilds(f.directory, version, "x64"), 0);
  for (const filename of previous)
    assert.equal(await readFile(path.join(f.directory, filename), "utf8"), "build");
});

test("local cleanup never follows symlinks", async (t) => {
  const f = await local(t);
  const external = path.join(f.directory, "keep.txt");
  await writeFile(external, "keep");
  await f.put(buildNames(version));
  await symlink(external, path.join(f.directory, "nyastra-2.0.0-linux-x64.zip"));
  assert.equal(await pruneLocalBuilds(f.directory, version, "x64"), 1);
  assert.equal(await readFile(external, "utf8"), "keep");
  await rm(path.join(f.directory, buildNames(version)[0]));
  await symlink(external, path.join(f.directory, buildNames(version)[0]));
  assert.equal(await pruneLocalBuilds(f.directory, version, "x64"), 0);
});

test(
  "the packaging command prunes only after the builder succeeds",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const f = await local(t);
    const root = f.directory;
    const put = async (filename, content) => {
      await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
      await writeFile(path.join(root, filename), content);
    };
    await put(
      "src/main/package-linux.mjs",
      await readFile(new URL("../../src/main/package-linux.mjs", import.meta.url), "utf8"),
    );
    await put("src/main/package.json", JSON.stringify({ version }));
    await put("src/shared/package.json", '{"type":"module"}');
    await put(
      "src/shared/src/programVersion.ts",
      await readFile(new URL("../../src/shared/src/programVersion.ts", import.meta.url), "utf8"),
    );
    await put(
      "scripts/releases/cleanup-builds.mjs",
      await readFile(new URL("./cleanup-builds.mjs", import.meta.url), "utf8"),
    );
    await symlink(
      new URL("./node_modules", import.meta.url),
      path.join(root, "scripts/releases/node_modules"),
      "dir",
    );
    await put("node_modules/electron-builder/package.json", '{"main":"cli.js"}');
    await put(
      "node_modules/electron-builder/cli.js",
      `
const fs = require('node:fs');
const path = require('node:path');
for (const ext of process.env.FIXTURE_BUILD_FORMATS.split(','))
  fs.writeFileSync(path.resolve('../../dist/nyastra-${version}-linux-x64.' + ext), 'new build');
process.exit(Number(process.env.FIXTURE_BUILD_STATUS));
`,
    );
    await put("node_modules/builder-util/package.json", "{}");
    await put("node_modules/app-builder-bin/package.json", '{"main":"index.js"}');
    await put(
      "node_modules/app-builder-bin/index.js",
      `exports.appBuilderPath = ${JSON.stringify(path.join(root, "helper"))};`,
    );
    await put("helper", "fixture helper");
    for (const name of buildNames("2.0.0")) await put(`dist/${name}`, "old build");
    const run = (status, formats = "zip,AppImage,deb") =>
      spawnSync(process.execPath, [path.join(root, "src/main/package-linux.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          FIXTURE_BUILD_STATUS: String(status),
          FIXTURE_BUILD_FORMATS: formats,
        },
        encoding: "utf8",
      });
    const failed = run(1);
    assert.equal(failed.status, 1, failed.stderr);
    for (const name of buildNames("2.0.0"))
      assert.equal(await readFile(path.join(root, "dist", name), "utf8"), "old build");
    const partial = run(0, "zip");
    assert.equal(partial.status, 0, partial.stderr);
    for (const name of buildNames("2.0.0"))
      assert.equal(await readFile(path.join(root, "dist", name), "utf8"), "old build");
    const succeeded = run(0);
    assert.equal(succeeded.status, 0, succeeded.stderr);
    assert.deepEqual((await readdir(path.join(root, "dist"))).sort(), buildNames(version).sort());
  },
);
