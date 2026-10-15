import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

const repository = "CateDesu/Nyastra-Mod-Manager";
const extensions = ["zip", "AppImage", "deb"];

function buildFile(name) {
  const match = /^nyastra-(.+)-linux-(x64|arm64|armv7l)\.(zip|AppImage|deb)(\.blockmap)?$/.exec(
    name,
  );
  if (!match || !semver.valid(match[1])) return undefined;
  return { version: match[1], arch: match[2], extension: match[3], blockmap: !!match[4] };
}

export async function pruneLocalBuilds(directory, version, arch) {
  if (!semver.valid(version)) throw new Error("Invalid replacement version");
  for (const extension of extensions) {
    try {
      const info = await lstat(
        path.join(directory, `nyastra-${version}-linux-${arch}.${extension}`),
      );
      if (!info.isFile() || info.size === 0) return 0;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }
  const obsolete = [];
  for (const name of await readdir(directory)) {
    const build = buildFile(name);
    if (!build || build.arch !== arch || semver.compareBuild(build.version, version) >= 0) continue;
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (info.isFile() || info.isSymbolicLink()) obsolete.push(filename);
  }
  for (const filename of obsolete) await unlink(filename);
  return obsolete.length;
}

function positiveId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid GitHub identifier");
  return value;
}

export function githubRequest(token, origin = "https://api.github.com") {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  return async (endpoint, method = "GET") => {
    if (!endpoint.startsWith("/") || endpoint.startsWith("//")) throw new Error("Invalid API path");
    const response = await fetch(`${origin}/repos/${repository}${endpoint}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Nyastra-Mod-Manager",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (method === "DELETE" && (response.status === 204 || response.status === 404)) return;
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };
}

async function pages(request, endpoint, field) {
  const all = [];
  for (let page = 1; ; page++) {
    const result = await request(`${endpoint}?per_page=100&page=${page}`);
    const batch = field ? result?.[field] : result;
    if (!Array.isArray(batch)) throw new Error("Invalid GitHub list response");
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function releasePlan(request, releaseId) {
  const releases = await pages(request, "/releases");
  const candidates = [];
  for (const release of releases) {
    positiveId(release.id);
    if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean")
      throw new Error("Invalid release state");
    if (release.draft || !semver.valid(release.tag_name)) continue;
    const channel =
      release.prerelease || semver.prerelease(release.tag_name) ? "preview" : "stable";
    const assets = await pages(request, `/releases/${release.id}/assets`);
    const builds = [];
    for (const asset of assets) {
      positiveId(asset.id);
      if (typeof asset.name !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 0)
        throw new Error("Invalid release asset");
      const build = buildFile(asset.name);
      if (build && semver.compareBuild(build.version, release.tag_name) === 0)
        builds.push({ ...build, asset });
    }
    candidates.push({ release, channel, builds });
  }
  const retained = new Map();
  for (const candidate of candidates) {
    for (const arch of new Set(candidate.builds.map((build) => build.arch))) {
      const complete = extensions.every((extension) =>
        candidate.builds.some(
          (build) =>
            build.arch === arch &&
            build.extension === extension &&
            !build.blockmap &&
            build.asset.state === "uploaded" &&
            build.asset.size > 0,
        ),
      );
      if (!complete) continue;
      const key = `${candidate.channel}/${arch}`;
      const previous = retained.get(key);
      if (
        !previous ||
        semver.compareBuild(candidate.release.tag_name, previous.release.tag_name) > 0
      )
        retained.set(key, candidate);
    }
  }
  if (
    releaseId &&
    ![...retained.values()].some((candidate) => candidate.release.id === releaseId)
  ) {
    const published = candidates.find((candidate) => candidate.release.id === releaseId);
    if (
      !published ||
      !extensions.every((extension) =>
        published.builds.some(
          (build) =>
            build.arch === "x64" &&
            build.extension === extension &&
            !build.blockmap &&
            build.asset.state === "uploaded" &&
            build.asset.size > 0,
        ),
      )
    )
      throw new Error(
        "Published release needs uploaded ZIP, AppImage and Debian builds before cleanup",
      );
  }
  return candidates.flatMap((candidate) =>
    candidate.builds
      .filter((build) => {
        const replacement = retained.get(`${candidate.channel}/${build.arch}`);
        return (
          replacement &&
          semver.compareBuild(candidate.release.tag_name, replacement.release.tag_name) < 0
        );
      })
      .map((build) => `/releases/assets/${build.asset.id}`),
  );
}

async function artifactPlan(request) {
  const artifacts = await pages(request, "/actions/artifacts", "artifacts");
  const builds = artifacts.filter((artifact) => artifact.name === "nyastra-linux-preview");
  for (const artifact of builds) {
    positiveId(artifact.id);
    positiveId(artifact.workflow_run?.id);
    if (
      !Number.isFinite(Date.parse(artifact.created_at)) ||
      typeof artifact.expired !== "boolean" ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 0
    )
      throw new Error("Invalid build artifact");
  }
  builds.sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
  );
  for (const artifact of builds) {
    if (
      artifact.expired ||
      artifact.size_in_bytes === 0 ||
      artifact.workflow_run.head_branch !== "main"
    )
      continue;
    const run = await request(`/actions/runs/${artifact.workflow_run.id}`);
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.head_branch !== "main" ||
      run.path !== ".github/workflows/package-linux.yml"
    )
      continue;
    return builds
      .filter(
        (old) =>
          old.id !== artifact.id &&
          (Date.parse(old.created_at) < Date.parse(artifact.created_at) ||
            (old.created_at === artifact.created_at && old.id < artifact.id)),
      )
      .map((old) => `/actions/artifacts/${old.id}`);
  }
  return [];
}

export async function cleanupGithubBuilds(request, { artifactsOnly = false, releaseId } = {}) {
  if (releaseId !== undefined) positiveId(releaseId);
  const releases = artifactsOnly ? [] : await releasePlan(request, releaseId);
  const artifacts = await artifactPlan(request);
  for (const endpoint of [...releases, ...artifacts]) await request(endpoint, "DELETE");
  return { releaseAssets: releases.length, artifacts: artifacts.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.env.GITHUB_REPOSITORY !== repository)
    throw new Error("Cleanup is restricted to the Nyastra repository");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const result = await cleanupGithubBuilds(githubRequest(process.env.GITHUB_TOKEN), {
    artifactsOnly: process.env.GITHUB_EVENT_NAME === "workflow_run",
    releaseId: event.release?.id,
  });
  console.log(
    `Removed ${result.releaseAssets} old release assets and ${result.artifacts} old build artifacts`,
  );
}
