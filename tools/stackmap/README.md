# StackMap

A developer extension for resolving copied stack traces against local source maps.
Open the program repository in VS Code and keep source maps under `sourcemaps/<version>`.
Use the Stack Map view to choose a version and read a stack trace from the clipboard.

Requires VS Code 1.74 or later. Build with Node 24 and npm:

```sh
npm ci
npm test
```

The extension entry point is `dist/extension.js`. VS Code supplies its extension API and clipboard access.
