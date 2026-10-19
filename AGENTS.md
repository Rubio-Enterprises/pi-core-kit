# Agent context

This repo follows Rubio-Enterprises standards.

## Repository guidance

`src/index.ts` is the public API. Keep it generic and independent of Pi: runtime imports
must use only `node:` built-ins. The package ships TypeScript source; build tasks check
types without emitting artifacts.

File and memory caches share name validation, JSON serialization and parser rejection
semantics. Preserve token-checked lock release after stale takeover. Filesystem failures
must remain best effort, with `openCache` providing the in-memory fallback.

Use temporary directories for tests; never write to the real Pi agent directory.
The test runner must prove a positive executed-test count for the Test Gate.
