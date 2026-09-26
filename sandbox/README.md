# Sandbox Project

A tiny throwaway workspace used as a **target** for real-machine smoke tests of
the assistant (e.g. pointing `ccr` at this directory and exercising Read/Edit/
Bash against `src/math.js`).

**It is NOT the sandboxing implementation.** The command sandbox / permission
policy lives in `src/sandbox-policy.ts` and friends under the repo's `src/`.
This directory is just inert sample content kept at the repo root for manual
testing; nothing here is imported by the product.
