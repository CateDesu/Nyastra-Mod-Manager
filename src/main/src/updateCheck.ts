import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { REPOSITORY_URL } from "@vortex/shared";
import type { LinuxUpdateCheck } from "@vortex/shared/ipc";
import got, { HTTPError } from "got";
import semver from "semver";
import { z } from "zod";

const execute = promisify(execFile);
const apiUrl = "https://api.github.com/repos/CateDesu/Nyastra-Mod-Manager";
const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), state: z.string() })),
  }),
);
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
});
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) });

interface IInstallation {
  packaged: boolean;
  version: string;
  appPath: string;
  arch: string;
}

async function githubJson(endpoint: string): Promise<unknown> {
  return got(`${apiUrl}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Nyastra-Mod-Manager",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    timeout: { request: 15_000 },
    retry: { limit: 0 },
  }).json();
}

export function createUpdateChecker(
  installation: () => IInstallation,
  request: (endpoint: string) => Promise<unknown> = githubJson,
): () => Promise<LinuxUpdateCheck> {
  let pending: Promise<LinuxUpdateCheck> | undefined;
  return () => {
    pending ??= check(installation(), request).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

async function check(
  installation: IInstallation,
  request: (endpoint: string) => Promise<unknown>,
): Promise<LinuxUpdateCheck> {
  const result: LinuxUpdateCheck = {
    kind: installation.packaged ? "package" : "source",
    status: "current",
    current: installation.version,
    checkedAt: Date.now(),
    url: installation.packaged
      ? `${REPOSITORY_URL}/releases`
      : `${REPOSITORY_URL}/blob/main/docs/updater.md`,
  };
  try {
    if (installation.packaged) {
      if (!semver.valid(installation.version)) throw new Error("Invalid installed version");
      let batch = releasesSchema.parse(await request("/releases?per_page=100"));
      const releases = [...batch];
      for (let page = 2; batch.length === 100; page++) {
        batch = releasesSchema.parse(await request(`/releases?per_page=100&page=${page}`));
        releases.push(...batch);
      }
      const preview = semver.prerelease(installation.version) !== null;
      const candidates = releases
        .filter((release) => {
          const parsed = semver.parse(release.tag_name);
          if (
            !parsed ||
            release.draft ||
            (!preview && (release.prerelease || parsed.prerelease.length > 0))
          )
            return false;
          const version = `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""}`;
          return release.assets.some(
            (asset) =>
              asset.state === "uploaded" &&
              ["zip", "AppImage", "deb"].some(
                (ext) => asset.name === `nyastra-${version}-linux-${installation.arch}.${ext}`,
              ),
          );
        })
        .sort((left, right) => semver.compareBuild(right.tag_name, left.tag_name));
      const latest = candidates[0];
      if (!latest) return { ...result, status: "unavailable", reason: "no-release" };
      return {
        ...result,
        status:
          semver.compareBuild(latest.tag_name, installation.version) > 0 ? "available" : "current",
        latest: latest.tag_name,
        url: `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(latest.tag_name)}`,
      };
    }

    const git = async (...args: string[]) =>
      (
        await execute("git", args, {
          cwd: installation.appPath,
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        })
      ).stdout.trim();
    result.current = await git("rev-parse", "HEAD");
    result.dirty = (await git("status", "--porcelain", "--untracked-files=normal")).length > 0;
    if ((await git("branch", "--show-current")) !== "main") {
      return { ...result, status: "unavailable", reason: "not-main" };
    }
    result.latest = commitSchema.parse(await request("/commits/main")).sha;
    if (result.current === result.latest) return result;
    let response: unknown;
    try {
      response = await request(`/compare/${result.current}...${result.latest}?per_page=1`);
    } catch (error) {
      if (error instanceof HTTPError && error.response.statusCode === 404) {
        return { ...result, status: "unavailable", reason: "local-history" };
      }
      throw error;
    }
    const comparison = comparisonSchema.parse(response);
    if (["behind", "diverged"].includes(comparison.status)) {
      return { ...result, status: "unavailable", reason: "local-history" };
    }
    return { ...result, status: comparison.status === "ahead" ? "available" : "current" };
  } catch {
    return { ...result, status: "error" };
  }
}
