# Attribution and modified source

Nyastra's Mod Manager is a modified Linux-only fork of Nexus Mods' Vortex,
licensed under GPL-3.0. Original copyright and license notices remain in the
source. This program is maintained independently by CateDesu and is not an
official Nexus Mods release.

Source: https://github.com/CateDesu/Nyastra-Mod-Manager

Linux Steam discovery, Proton environment and game-directory handling,
case compatibility, desktop cache refresh and distribution packaging were
reviewed against atabisz/Vortex at commit
2da046fe14124e33136334d7da65d3793eb318a2. Useful behavior was adapted to the
newer Vortex base and checked locally. The fork's source and original notices
are available at https://github.com/atabisz/Vortex.

The portable INI package retains the public interfaces of Nexus Mods'
vortex-parse-ini and uses a new Linux implementation. Its file editor preserves
comments, encoding, line endings and symlinks without the Windows API.

The Astra mascot in assets/images/nyastra.png was generated for this program.
Its generation prompt and tool record are in assets/images/nyastra.prompt.txt.
No reference artwork was supplied for that generation.

Nexus Mods website addresses, accounts, services and download protocols retain
their service names. Game names and artwork identify their respective games.
See LICENSE.md and Dependency Report.md in the packaged program for licenses.
