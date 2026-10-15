# Linux updates

Nyastra's Mod Manager checks its own GitHub repository ten seconds after startup
and every six hours while running. **Linux updates** in Settings provides **Check now** and
an **Automatically check for updates** switch. Manual checks work when automatic
checking is off. Network failures can be retried without restarting.

Checking only reads update metadata. It never replaces program files, pulls Git
changes or merges local work. An available update opens a release page or these
instructions. The Windows installer updater and Nexus update feed are removed.

## Installed packages

Packages check [Nyastra releases](https://github.com/CateDesu/Nyastra-Mod-Manager/releases)
for uploaded Linux assets matching the current architecture. Stable versions use
stable releases. Preview versions also include prereleases. Linux build numbers
such as `+linux.10` are compared so successive builds of one preview are detected.
If no compatible release is published, the settings page says so.

Close the program before installing an update. Keep using the same package format:

- ZIP: extract the new archive and run `./install.sh`. The installer replaces the
  installed runtime, retains user settings and rolls back if desktop registration
  fails. The extraction can then be removed.
- AppImage: replace the previous AppImage with the new one, make it executable
  and update any launcher that refers to its old filename.
- Debian package: install the new `.deb` through your package manager.

Settings remain under `$XDG_CONFIG_HOME/NyastraModManager`, or
`~/.config/NyastraModManager` when that variable is unset. Keep any custom
`--user-data` location when restarting. Mod archives and staging folders remain
at their configured paths. See [Linux packaging](packaging/linux.md) for build
requirements and installation details.

## Source clones

A program running from source checks its local commit against Nyastra's `main`
branch. It reports local edits without changing them. Detached checkouts, other
branches and unpublished or diverged commits need manual review before updating.
A package built from a clone uses the package check instead.

Close the running program. From the clone's root, inspect your branch, remote and
local changes with `git status` and `git remote -v`. The `origin` URL should be
`https://github.com/CateDesu/Nyastra-Mod-Manager.git`, or its SSH equivalent.
Save local work before proceeding. Once the working tree is clean and `main` can
fast-forward:

```bash
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run verify
pnpm start
```

Use the pinned Node and pnpm versions and the prerequisites in
[source setup](install-instructions/README.md). A failed fast-forward leaves
your commits in place. Resolve that history deliberately before retrying.
If you use an installed package built from the clone, rebuild and install it
using [Linux packaging](packaging/linux.md) after updating the source.
