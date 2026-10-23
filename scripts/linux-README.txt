Nyastra's Mod Manager for Linux

Testing preview v1.02.
Independent GPL-3.0 fork of Nexus-Mods/Vortex, maintained by CateDesu.
Source: https://github.com/CateDesu/Nyastra-Mod-Manager/tree/v2.9.2
Support: https://github.com/CateDesu/Nyastra-Mod-Manager/issues

Extract the ZIP and run ./install.sh. Open Nyastra's Mod Manager from the menu
or ~/.local/bin/nyastra-mod-manager. The runtime is copied into
$XDG_DATA_HOME/nyastra-mod-manager/app, normally
~/.local/share/nyastra-mod-manager/app. You can then remove the extraction.
Run ./nyastra-mod-manager directly for a portable runtime.

To import an existing Linux profile, first close both programs and run:
./install.sh --import-profile /absolute/path/to/Vortex
Import refuses an existing Nyastra profile and never changes the source profile.
Archives and staging folders stay where they are. Account credentials are reset.
Settings live in $XDG_CONFIG_HOME/NyastraModManager, normally
~/.config/NyastraModManager. Import needs psmisc. Desktop registration needs
xdg-utils and desktop-file-utils. The installer lock needs util-linux.

Nexus Mods application registration is pending. A personal API key can be entered
for testing and registration review. Public integrated login needs Nyastra's own
approved identifiers. Do not distribute this preview as a completed public client.
Real Nexus Mods website names and download addresses are intentionally retained.

Native XML FOMOD requires glibc 2.38+ and libstdc++ providing GLIBCXX_3.4.32 and
CXXABI_1.3.15. Legacy C# installers are unsupported. Windows game tools still
require Wine or Proton. Native Linux game paths remain case-sensitive.
Hardlink staging must share the filesystem of its game or mod output.

Installed RE4 0.4.1 and Requiem 0.1.3 extensions receive Linux adaptations.
Configure Fluffy in $XDG_CONFIG_HOME/nyastra-mod-manager/fluffy.json. The included
linux-extensions recipe contains no third-party extension assets. Close Nyastra
and rerun its installed app/install.sh after adding a supported extension.

Updates are checked automatically from the Nyastra release page. Use Linux updates
in Settings to check now or disable automatic checking. Close the program and install
the new package when ready. See https://github.com/CateDesu/Nyastra-Mod-Manager/blob/main/docs/updater.md.
No upstream analytics or
Nexus crash uploads are enabled. Logs are shared manually through the own issue
tracker only after you review their contents.

See LICENSE.md, NOTICE.md and Dependency Report.md for licenses and attribution.
