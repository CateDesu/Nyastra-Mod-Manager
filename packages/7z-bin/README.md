# Bundled 7-Zip

The unmodified Linux x64 `7zzs` executable comes from the official
[7-Zip 26.05 release](https://github.com/ip7z/7zip/releases/tag/26.05), asset
`7z2605-linux-x64.tar.xz`. Its [source](https://github.com/ip7z/7zip/tree/26.05)
and redistribution terms are available with the release. `License.txt` is copied
from that archive.

This workspace package retains the `7z-bin` path API used by extensions and
`node-7z`. Both resolve this same executable. Nyastra's published packages support
Linux x64.

When updating, replace the executable and license from the official archive,
update the package version and the archive version check, then run
`node --test scripts/archive-runtime.test.mjs`.
