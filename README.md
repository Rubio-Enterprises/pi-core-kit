# pi-core-kit

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/Rubio-Enterprises/pi-core-kit)

Host-independent building blocks for Pi extensions.

Every module uses only Node built-ins and never imports Pi, so it can be tested and reused
without a Pi host. It ships ESM TypeScript source with no build step or runtime dependencies,
for Bun and Pi's TypeScript extension loader, not JavaScript-only loaders. Each module is a
subpath export; there is no root entry point. UI components that need Pi's TUI live in
[pi-ui-kit](https://github.com/Rubio-Enterprises/pi-ui-kit), which may depend on this package;
this package never depends on it.

Formerly `pi-session-cache`. The session cache was extracted from pi-subscription-usage.

| Module | Purpose |
| --- | --- |
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
npm install 'git+https://github.com/Rubio-Enterprises/pi-core-kit.git#v2.0.0'
```

The dependency spec is:

```json
{
  "dependencies": {
    "pi-core-kit": "git+https://github.com/Rubio-Enterprises/pi-core-kit.git#v2.0.0"
  }
}
```

## Usage

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
