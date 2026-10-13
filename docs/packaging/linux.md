# Linux packaging

Nyastra's Mod Manager supports Linux desktops. Windows games, game file formats
and Proton tools remain supported where their individual extensions work.

## Build

Install the prerequisites in [source setup](../install-instructions/README.md),
including patchelf, a .NET 9 SDK, xdg-utils, desktop-file-utils, util-linux and
psmisc. Use the pinned pnpm and Node versions from package.json.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run verify
NODE_ENV=production pnpm nx run @vortex/main:publish
pnpm --filter @vortex/main run package:nosign --x64
node scripts/verify-packaged-asar.mjs
node scripts/stage-linux-release.mjs
```

The package version is maintained in src/main/package.json. Packaging produces
ZIP, AppImage and Debian artifacts in dist/. Staging collects them under
dist/release/assets with release notes and the matching source tag. Publish the
source tag before distributing a binary. Preserve GPL and dependency notices.

Run commands from the workspace. Running pnpm inside src/main/dist can cause
pnpm to replace the deployed dependency tree. Recreate it with the publish
command if necessary. Use NODE_ENV=production for the publish build, and leave
NODE_ENV unset when running tests.

## Install and profile import

Extract the ZIP and run `./install.sh`. The installer copies the runtime into
`$XDG_DATA_HOME/nyastra-mod-manager/app` and creates the
`~/.local/bin/nyastra-mod-manager` launcher and
`io.github.CateDesu.NyastraModManager.desktop` menu entry. The extracted directory
can then be removed. A flock prevents concurrent installs, and desktop
registration failures restore the previous runtime and launcher state.

Close the program before replacing its runtime. Settings are stored separately
under `$XDG_CONFIG_HOME/NyastraModManager`. To import an existing Linux profile:

```bash
./install.sh --import-profile /absolute/path/to/Vortex
```

The import refuses an existing destination or an open database. It copies the
state and plugins, rejects symlinks and preserves the source. Archives and mod
staging folders remain at their existing paths. Credentials are removed and
analytics disabled before hydration. The staging ownership ID is retained.
The import does not read or migrate a Lutris or Wine Windows profile.

For hardlink deployment, staging and game or mod output must share a filesystem.
The portable [Linux extension recipe](linux-extensions.md) adapts supported
installed extensions without distributing their third-party assets.

## Limits and privacy

The preview is locally tested on CachyOS x64. Native FOMOD libraries require
glibc 2.38+ and libstdc++ providing GLIBCXX_3.4.32 and CXXABI_1.3.15. AppImage
bundling does not remove these native library requirements. Other distributions
need independent validation.

Legacy C# FOMOD installers are unsupported. Windows game tools require Proton or
Wine. Optional MT Framework ARC support needs ARCtool; a failed download leaves
that format unavailable. Individual game and collection validation remains
necessary. The optional ext4 casefold attempt applies only to newly created,
empty directories and falls back to path resolution when unsupported.

Nexus application registration is pending. See [registration](nexus-registration.md).
Own desktop and profile identities are separate from Vortex. Updates and support
use the Nyastra repository. Upstream analytics, feature-flag requests and crash
uploads are disabled. Users choose which reviewed logs to share manually.

## Verification

`pnpm run verify` runs formatting, builds, lint, type checks, unit and integration
tests. It excludes the official game E2E suite. Linux installer checks are:

```bash
node --test scripts/install-linux.test.mjs scripts/import-linux-profile.test.mjs
node scripts/smoke-linux.mjs dist/linux-unpacked/nyastra-mod-manager
node linux/extension-adaptations/verify.mjs --source-plugins /path/to/original/plugins
```

The startup check uses a disposable profile and needs a display. CI uses Xvfb
and a sandbox helper prepared on its disposable runner. Extension verification
needs original supported third-party plugins, which are not bundled here.
