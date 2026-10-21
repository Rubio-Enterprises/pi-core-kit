# Agent context

This repo follows Rubio-Enterprises standards.

## Repository guidance

pi-core-kit holds host-independent building blocks for Pi extensions. Use
[GLOSSARY.md](GLOSSARY.md) vocabulary. The split from pi-ui-kit is recorded in
[pi-ui-kit ADR 0001](https://github.com/Rubio-Enterprises/pi-ui-kit/blob/main/docs/adr/0001-shared-libraries-split-by-dependency.md);
the rule for third-party libraries in [pi-ui-kit ADR 0003](https://github.com/Rubio-Enterprises/pi-ui-kit/blob/main/docs/adr/0003-core-kit-takes-justified-libraries.md).

Invariants:

- Runtime imports in `src/` use `node:` built-ins, sibling modules and the libraries allowed in
  `tests/boundary.test.ts` (today only `typebox`). Pi provides `typebox` to extensions as a
  virtual module and warns when a package installs its own, so it is a `*` peer with an exact
  dev pin, never a dependency. Never import Pi or pi-ui-kit. Add a library
  only with an ADR that justifies it, then add it to the boundary test. Code that needs a Pi
  host belongs in pi-ui-kit or in the extension.
- `atomic-write.ts` is internal: shared by modules here, never exported.
- Each module is `src/<name>.ts`, exported as the subpath `./<name>`. There is no root entry
  point, so adding a module never changes another module's surface.
- The package ships TypeScript source; build tasks check types without emitting artifacts.
  Consumers compile that source with their own settings, so `tsconfig.strict.json` checks it
  under the strictest common ones (including `exactOptionalPropertyTypes`); keep it passing.
- Add a module only when at least two extensions need it.

`config-file`: mechanics only. Never decide what a missing or invalid file means for an
extension; return a read outcome. `update` must never overwrite a file it cannot parse and must
re-check the file just before the rename.

`session-cache`: file and memory caches share name validation, JSON serialization and parser
rejection semantics. Preserve token-checked lock release after stale takeover. Filesystem
failures must remain best effort, with `openCache` providing the in-memory fallback.

Use temporary directories for tests; never write to the real Pi agent directory.
The test runner must prove a positive executed-test count for the Test Gate.
