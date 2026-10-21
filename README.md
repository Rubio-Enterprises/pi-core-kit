# pi-core-kit

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/Rubio-Enterprises/pi-core-kit)

Host-independent building blocks for Pi extensions.

No module imports Pi, so each can be tested and reused without a Pi host. Modules use Node
built-ins plus a short list of justified libraries; today that is only
[TypeBox](https://github.com/sinclairzx81/typebox), the schema library Pi itself uses. TypeBox
is a `*` peer: Pi supplies its own copy to extensions, and anything else installs it. It ships
ESM TypeScript source with no build step, for Bun and Pi's TypeScript extension loader, not
JavaScript-only loaders. Each module is a
subpath export; there is no root entry point. UI components that need Pi's TUI live in
[pi-ui-kit](https://github.com/Rubio-Enterprises/pi-ui-kit), which may depend on this package;
this package never depends on it.

Formerly `pi-session-cache`. The session cache was extracted from pi-subscription-usage; the
config file module from pi-capability-exposure's config store.

| Module | Purpose |
| --- | --- |
| `pi-core-kit/config-file` | Read, validate and safely update an extension's JSON config file |
| `pi-core-kit/session-cache` | File and memory caches coordinated across processes |

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Contributing](#contributing)
- [License](#license)

## Install

Pin a release tag:

```sh
npm install 'git+https://github.com/Rubio-Enterprises/pi-core-kit.git#v2.1.2'
```

The dependency spec is:

```json
{
  "dependencies": {
    "pi-core-kit": "git+https://github.com/Rubio-Enterprises/pi-core-kit.git#v2.1.2"
  }
}
```

## Usage

```ts
import { ConfigFile, readConfig } from 'pi-core-kit/config-file';
import { Type } from 'typebox';

const DenyList = Type.Object({ tools: Type.Optional(Type.Array(Type.String())) });
const outcome = readConfig('/path/to/tool-deny.json', { schema: DenyList });
if (outcome.status === 'invalid') throw new Error(`tool-deny.json: ${outcome.reason}`);
const tools = outcome.status === 'value' ? (outcome.value.tools ?? []) : [];

const rules = new ConfigFile('/path/to/rules.json');
rules.update((root) => ({ ...root, echo: 'off' }));
```

```ts
import { openCache } from 'pi-core-kit/session-cache';

const cache = openCache('/tmp/my-session-cache');
const parse = (raw: unknown) => typeof raw === 'number' ? raw : undefined;
const stop = cache.watch((name) => {
  if (name === 'results' || name === undefined) {
    console.log(cache.read('results', parse));
  }
});
const release = cache.tryLock('results');
if (release) {
  try {
    cache.write('results', 42);
  } finally {
    release();
  }
}
// On shutdown:
stop();
```

## API

### `pi-core-kit/config-file`

The module owns the mechanics of a config file; each extension keeps its own policy for what a
missing or invalid file means (fail loudly, warn once, fall back to defaults).

- `type ConfigRead<T>` is `{ status: 'missing' }`, `{ status: 'value', value: T }` or
  `{ status: 'invalid', reason }`. `invalid` covers unreadable files, malformed JSON, a
  non-object root and schema violations; `reason` excludes the path. Values are deeply frozen.
- `readConfig(path, { schema?, fs? }): ConfigRead` reads once. Without a schema the value is any
  JSON object. A missing file is `missing`, never an error.
- `parseConfigText(text, schema?): ConfigRead` is the same check on text: it strips a byte order
  mark, requires a JSON object, then applies the schema.
- `describeErrors(schema, value): string` formats schema problems as `path: message; …`, for an
  extension that validates single entries itself.
- `new ConfigFile(path, { schema?, fs? })`:
  - `read(): ConfigRead` stats the file on each call and re-reads it only when its modification
    time or size changed. It returns the same outcome object until then, so callers can skip
    re-deriving state by comparing identity.
  - `update(edit: (root) => root): void` edits safely. `edit` gets a mutable copy of the current
    root (`{}` for a missing file) and may run more than once, so keep it pure. It refuses to
    overwrite a file it cannot read or parse, validates the result against the schema, keeps
    the file's mode (0600 for a new file), writes through an exclusive temporary file and an
    atomic rename, and starts over if the file changed meanwhile, giving up after three tries.
- `ConfigFs` is the injectable subset of `node:fs` the module uses, for tests.

This is not a lock: two writers can both succeed in turn, each re-applying its edit to the other's
result. Change detection uses modification time and size, so a same-size rewrite within the
filesystem's timestamp resolution can be missed by `read` until the next change.

### `pi-core-kit/session-cache`

All constructors return the `SessionCache` interface. Names must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$` exactly. Invalid names return undefined from
`read` and `tryLock`; `write` and `remove` are no-ops.

- `fileCache(dir, options?: { now?: () => number }): SessionCache | undefined` creates
  the directory with mode 0700 and probes writability. Existing permissions are not
  changed. Returns undefined if unusable. The optional clock controls lock aging.
- `memoryCache(): SessionCache` creates a private per-instance cache. It uses JSON
  serialization, parser rejection, locks and debounced notifications like the file cache,
  but has no cross-process sharing.
- `openCache(dir, options?): SessionCache` returns `fileCache(dir, options) ?? memoryCache()`.
  Later I/O failures are best effort; they do not switch an existing cache to memory.
- `read<T>(name, parse: (raw: unknown) => T | undefined): T | undefined` parses
  `<name>.json`. Missing, malformed, unreadable, rejected or throwing parsers return undefined.
- `write(name, value: unknown): void` atomically replaces `<name>.json` using a
  unique temporary file and rename, with mode 0600. Serialization or I/O failure leaves
  the previous entry intact. Never throws; values must be JSON-serializable.
- `remove(name): void` deletes `<name>.json`; missing entries are a no-op. Never throws.
- `list(prefix = ''): Array<{ name: string; mtimeMs: number }>` lists JSON entry names
  without the suffix and their modification times, optionally filtered by prefix.
  Order is unspecified. Unreadable directories return an empty array.
- `tryLock(name): (() => void) | undefined` exclusively creates `<name>.lock` with
  a PID, random token and timestamp. A live lock returns undefined. A dead PID or an
  age greater than `LOCK_STALE_MS` (30,000 ms) allows takeover. Release checks the token
  so an expired holder does not remove its successor's lock. Memory locks expire by age.
- `watch(onChange: (name: string | undefined) => void): () => void` watches writes
  and removals, debouncing each burst for about 100 ms. Delivers every changed name;
  undefined means the filesystem did not supply a name. Timers and file watchers are
  unref'd. Stop cancels pending notifications. Watching is a no-op when unavailable.

These are cooperative local cache locks, not a distributed transaction or a security
boundary. Stale takeover can race with another contender or a slow original holder;
keep critical sections short and make refreshes safe to repeat. Write only while holding
the relevant lock when coordinating a shared refresh. Directory watching is advisory:
callers should retain a polling fallback. Use an application-owned directory; do not
store credentials in cache entries.

## Contributing

Questions and bug reports belong in [issues](https://github.com/Rubio-Enterprises/pi-core-kit/issues).
Pull requests are welcome. Use Conventional Commits and run `mise run lint`,
`mise run typecheck` and `mise run test` before submitting. `mise run setup` installs
the pinned tools and dependencies. Tests use Bun and temporary directories.

## License

[MIT](LICENSE) © 2026 Rubio Enterprises.
