# @nyastra/deepmerge build dependency

Private fork of deepmerge 4.3.1's bundled CommonJS distribution under its MIT license.

The patch defines destination properties directly in both object merge paths. Dictionary keys remain own data properties without changing the returned object's prototype, addressing GHSA-gcqx-w48m-w2h4. The private package name identifies the patched fork without claiming an upstream fixed version.

The file override preserves the webpack TypeScript checker's `deepmerge` import. Remove the override when an upstream fixed release is available.

Source: https://github.com/TehShrike/deepmerge/tree/v4.3.1
Advisory: https://github.com/advisories/GHSA-gcqx-w48m-w2h4
