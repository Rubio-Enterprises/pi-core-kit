# Agent context

This repo follows Rubio-Enterprises standards.

## Repository guidance

pi-core-kit holds host-independent building blocks for Pi extensions. Use
[GLOSSARY.md](GLOSSARY.md) vocabulary. The split from pi-ui-kit is recorded in
[pi-ui-kit ADR 0001](https://github.com/Rubio-Enterprises/pi-ui-kit/blob/main/docs/adr/0001-shared-libraries-split-by-dependency.md).

Invariants:

- Runtime imports in `src/` use only `node:` built-ins and sibling modules. Never import Pi,
  pi-ui-kit or any npm package; `tests/boundary.test.ts` enforces this. Code that needs a Pi
  host belongs in pi-ui-kit or in the extension.
- Each module is `src/<name>.ts`, exported as the subpath `./<name>`. There is no root entry
  point, so adding a module never changes another module's surface.
- The package ships TypeScript source; build tasks check types without emitting artifacts.
- Add a module only when at least two extensions need it.

`session-cache`: file and memory caches share name validation, JSON serialization and parser
rejection semantics. Preserve token-checked lock release after stale takeover. Filesystem
failures must remain best effort, with `openCache` providing the in-memory fallback.

Use temporary directories for tests; never write to the real Pi agent directory.
The test runner must prove a positive executed-test count for the Test Gate.
