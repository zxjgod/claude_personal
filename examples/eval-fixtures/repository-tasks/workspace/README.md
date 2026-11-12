# Task catalog

The package exposes its API through src/index.ts. Its implementation currently lives in src/legacy.ts; src/commands.ts renders todo task titles.

Run `node build.mjs` to compile with the local evaluation toolchain, then `node test.mjs` to run the package checks. No dependency installation is needed. Build/test drivers, package metadata, compiler settings and ignore rules are protected evaluation inputs.
