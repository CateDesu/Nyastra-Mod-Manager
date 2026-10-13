# Nyastra's Mod Manager Linux testing preview

Version 2.9.0-beta.2+linux.2. This is an independent Linux-only Vortex fork.

Source for these binaries:
https://github.com/CateDesu/Nyastra-Mod-Manager/tree/v2.9.0-beta.2+linux.2

Download the ZIP, extract it and run `./install.sh`. The user installer copies the
runtime to `~/.local/share/nyastra-mod-manager/app` and registers the menu entry
and Nexus Mods `nxm:` download links. No separate Node installation is needed.
AppImage and Debian packages are also provided as testing artifacts.

To import an existing Linux profile, close both programs and run:
`./install.sh --import-profile /absolute/path/to/Vortex`
The import requires psmisc, refuses an existing Nyastra profile, rejects symlinks
and preserves the source. Archives and staging folders keep their original paths.
Sign in again after import. The new profile is `~/.config/NyastraModManager`.

This preview includes native archives and XML FOMOD installation, multiple Linux
Steam installations, Proton tool environment setup, game INI editing, filename
case compatibility and RE4 0.4.1 / Requiem 0.1.3 Linux extension adaptations.
Configure Fluffy using the Linux extension guide.

Locally tested on CachyOS x64. Native FOMOD requires glibc 2.38+ and libstdc++
providing GLIBCXX_3.4.32 and CXXABI_1.3.15. Legacy C# installers are unsupported.
Windows game tools still need Wine or Proton. Hardlink staging must share the
filesystem of the game or mod output. This does not claim validation of every
supported Vortex game or live gameplay.

Nexus Mods application registration is pending. Personal API keys are offered
for testing and registration review only. Integrated public sign-in needs
Nyastra's own approved application identifiers. Automatic updates, Nexus crash
uploads and upstream analytics are disabled. Use the Nyastra repository for
support and manual releases.

License: GPL-3.0. See LICENSE.md, NOTICE.md and Dependency Report.md in the package.
Linux work reviewed from atabisz/Vortex is credited in NOTICE.md. The source tag
above identifies the exact modified source for this build.
