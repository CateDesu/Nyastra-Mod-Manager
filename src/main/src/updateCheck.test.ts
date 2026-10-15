import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import got from "got";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createUpdateChecker } from "./updateCheck";

const execute = promisify(execFile);
let directory: string;
let server: Server;
let payload: (url: string) => unknown;
let status: number;
let request: (endpoint: string) => Promise<unknown>;
let requests: string[];
const remoteCommit = "a".repeat(40);

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nyastra-update-"));
  status = 200;
  requests = [];
  payload = () => [];
  server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload(req.url!)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  request = (endpoint) =>
    got(`http://127.0.0.1:${(server.address() as AddressInfo).port}${endpoint}`, {
      retry: { limit: 0 },
      timeout: { request: 1000 },
    }).json();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const installation = (packaged = true, version = "2.9.0-beta.2+linux.2") => ({
  packaged,
  version,
  appPath: directory,
  arch: "x64",
});
const release = (version: string, overrides = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: semverPreview(version),
  assets: [{ name: `nyastra-${version}-linux-x64.zip`, state: "uploaded" }],
  ...overrides,
});
const semverPreview = (version: string) => version.split("+")[0]!.includes("-");
const git = async (...args: string[]) =>
  (
    await execute("git", args, {
      cwd: directory,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CateDesu",
        GIT_COMMITTER_NAME: "CateDesu",
        GIT_AUTHOR_EMAIL: "205492565+CateDesu@users.noreply.github.com",
        GIT_COMMITTER_EMAIL: "205492565+CateDesu@users.noreply.github.com",
      },
    })
  ).stdout.trim();
async function cloneFixture() {
  await git("init", "-b", "main");
  await writeFile(path.join(directory, "program.txt"), "original");
  await git("add", "program.txt");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture");
  await mkdir(path.join(directory, "src/main"), { recursive: true });
  return git("rev-parse", "HEAD");
}

describe("packaged update checks over HTTP", () => {
  it("finds a newer Linux build even when only SemVer build metadata changes", async () => {
    payload = () => [release("2.9.0-beta.2+linux.2"), release("2.9.0-beta.2+linux.10")];
    const result = await createUpdateChecker(() => installation(), request)();
    expect(result).toMatchObject({
      status: "available",
      kind: "package",
      latest: "v2.9.0-beta.2+linux.10",
    });
    expect(result.url).toBe(
      "https://github.com/CateDesu/Nyastra-Mod-Manager/releases/tag/v2.9.0-beta.2%2Blinux.10",
    );
  });

  it("ignores drafts, other architectures, upstream assets and unfinished uploads", async () => {
    payload = () => [
      release("3.0.0", { draft: true }),
      release("4.0.0", { assets: [{ name: "nyastra-4.0.0-linux-arm64.zip", state: "uploaded" }] }),
      release("5.0.0", { assets: [{ name: "vortex-5.0.0.exe", state: "uploaded" }] }),
      release("6.0.0", { assets: [{ name: "nyastra-6.0.0-linux-x64.zip", state: "new" }] }),
      release("2.9.0-beta.2+linux.2"),
    ];
    expect(await createUpdateChecker(() => installation(), request)()).toMatchObject({
      status: "current",
      latest: "v2.9.0-beta.2+linux.2",
    });
  });

  it("keeps stable installations on stable releases", async () => {
    payload = () => [release("4.0.0-beta.1"), release("3.1.0")];
    expect(await createUpdateChecker(() => installation(true, "3.0.0"), request)()).toMatchObject({
      status: "available",
      latest: "v3.1.0",
    });
  });

  it.each([false, true])(
    "finds the newest compatible release beyond the first page with an earlier candidate: %s",
    async (earlierCandidate) => {
      const firstPage = Array.from({ length: 100 }, (_, index) => release(`4.0.0-beta.${index}`));
      if (earlierCandidate) firstPage[0] = release("3.0.0");
      payload = (url) =>
        new URL(url, "http://localhost").searchParams.get("page") === "2"
          ? [release("3.1.0")]
          : firstPage;
      expect(await createUpdateChecker(() => installation(true, "3.0.0"), request)()).toMatchObject(
        {
          status: "available",
          latest: "v3.1.0",
        },
      );
      expect(requests).toHaveLength(2);
    },
  );

  it("does not report current after a later release page fails and permits retry", async () => {
    payload = (url) =>
      new URL(url, "http://localhost").searchParams.get("page") === "2"
        ? { unavailable: true }
        : Array.from({ length: 100 }, () => release("2.0.0"));
    const check = createUpdateChecker(() => installation(true, "3.0.0"), request);
    expect(await check()).toMatchObject({ status: "error" });
    payload = () => [release("3.1.0")];
    expect(await check()).toMatchObject({ status: "available", latest: "v3.1.0" });
  });

  it.each(["zip", "AppImage", "deb"])(
    "recognizes an uploaded %s as a compatible release",
    async (ext) => {
      payload = () => [
        release("3.0.0", {
          assets: [{ name: `nyastra-3.0.0-linux-x64.${ext}`, state: "uploaded" }],
        }),
      ];
      expect(await createUpdateChecker(() => installation(), request)()).toMatchObject({
        status: "available",
        latest: "v3.0.0",
      });
    },
  );

  it("reports an unpublished channel without claiming the installation is current", async () => {
    expect(await createUpdateChecker(() => installation(), request)()).toMatchObject({
      status: "unavailable",
      reason: "no-release",
    });
  });

  it("coalesces concurrent checks and recovers after an HTTP failure", async () => {
    status = 429;
    const check = createUpdateChecker(() => installation(), request);
    const first = check();
    expect(check()).toBe(first);
    expect(await first).toMatchObject({ status: "error" });
    expect(requests).toHaveLength(1);
    status = 200;
    payload = () => [release("3.0.0")];
    expect(await check()).toMatchObject({ status: "available" });
    expect(requests).toHaveLength(2);
  });

  it("rejects malformed metadata", async () => {
    payload = () => ({ unexpected: true });
    expect(await createUpdateChecker(() => installation(), request)()).toMatchObject({
      status: "error",
    });
  });
});

describe("source checks with actual Git checkouts", () => {
  it("detects new main commits from a nested app directory without changing local files or refs", async () => {
    const head = await cloneFixture();
    await writeFile(path.join(directory, "program.txt"), "local edits");
    payload = (url) => (url === "/commits/main" ? { sha: remoteCommit } : { status: "ahead" });
    const check = createUpdateChecker(
      () => ({ ...installation(false), appPath: path.join(directory, "src/main") }),
      request,
    );
    expect(await check()).toMatchObject({
      kind: "source",
      status: "available",
      current: head,
      latest: remoteCommit,
      dirty: true,
    });
    expect(requests).toEqual(["/commits/main", `/compare/${head}...${remoteCommit}?per_page=1`]);
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(directory, "program.txt"), "utf8")).toBe("local edits");
  });

  it("recognizes the current commit without a comparison request", async () => {
    const head = await cloneFixture();
    payload = () => ({ sha: head });
    expect(await createUpdateChecker(() => installation(false), request)()).toMatchObject({
      status: "current",
      dirty: false,
    });
    expect(requests).toEqual(["/commits/main"]);
  });

  it.each(["behind", "diverged"])(
    "reports %s history instead of offering an unsafe fast-forward",
    async (comparison) => {
      await cloneFixture();
      payload = (url) => (url === "/commits/main" ? { sha: remoteCommit } : { status: comparison });
      expect(await createUpdateChecker(() => installation(false), request)()).toMatchObject({
        status: "unavailable",
        reason: "local-history",
      });
    },
  );

  it("handles a commit that has never been published", async () => {
    await cloneFixture();
    const get = async (endpoint: string) => {
      status = endpoint === "/commits/main" ? 200 : 404;
      payload = () => ({ sha: remoteCommit });
      return request(endpoint);
    };
    expect(await createUpdateChecker(() => installation(false), get)()).toMatchObject({
      status: "unavailable",
      reason: "local-history",
    });
  });

  it("leaves detached source checkouts alone", async () => {
    await cloneFixture();
    await git("checkout", "--detach");
    expect(await createUpdateChecker(() => installation(false), request)()).toMatchObject({
      status: "unavailable",
      reason: "not-main",
    });
    expect(requests).toHaveLength(0);
  });

  it("reports a missing checkout without rejecting or touching the network", async () => {
    expect(await createUpdateChecker(() => installation(false), request)()).toMatchObject({
      status: "error",
    });
    expect(requests).toHaveLength(0);
  });
});
