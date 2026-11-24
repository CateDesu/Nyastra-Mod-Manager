# Nyastra's Mod Manager

## Builds

- After every program change, build a fresh Linux x64 binary from the current checkout before handing it back. Follow the build steps in `docs/packaging/linux.md` and verify the packaged executable in `dist/linux-unpacked/nyastra-mod-manager` with the packaged startup check.

## Releases

- After every push to `main`, cut and publish a release for the pushed commit.
- Prepare the new version in `src/main/package.json` before pushing. Run **Package Linux preview** on `main` and verify the published downloads before reporting the push complete.
