import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileCache,
  LOCK_STALE_MS,
  memoryCache,
  openCache,
  type SessionCache,
} from '../src/index.ts';

const roots: string[] = [];
const stops: Array<() => void> = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-cache-'));
  roots.push(root);
  return root;
}
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value');
  return value;
}
function number(raw: unknown): number | undefined {
  return typeof raw === 'number' ? raw : undefined;
}
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const backend of ['file', 'memory'] as const) {
  describe(backend, () => {
    function cache(): SessionCache {
      return backend === 'file' ? present(fileCache(directory())) : memoryCache();
    }
    test('JSON round-trip, parser rejection and missing values', () => {
      const c = cache();
      expect(c.read('absent', number)).toBeUndefined();
      c.write('results', 4);
      expect(c.read('results', number)).toBe(4);
      c.write('results', 'not a number');
      expect(c.read('results', number)).toBeUndefined();
      expect(
        c.read('results', () => {
          throw new Error('rejected');
        }),
      ).toBeUndefined();
      const original = { count: 3 };
      c.write('results', original);
      original.count = 5;
      const first = c.read('results', (raw) => raw as { count: number });
      expect(first).toEqual({ count: 3 });
      present(first).count = 9;
      expect(c.read('results', (raw) => raw)).toEqual({ count: 3 });
    });
    test('failed serialization preserves previous entry and never throws', () => {
      const c = cache();
      c.write('results', 4);
      const circular: { self?: unknown } = {};
      circular.self = circular;
      for (const value of [circular, 1n, undefined, () => {}]) {
        expect(() => c.write('results', value)).not.toThrow();
        expect(c.read('results', number)).toBe(4);
      }
    });
    test('list filters prefixes and remove is idempotent', () => {
      const c = cache();
      c.write('session-a', 1);
      c.write('session-b', 2);
      c.write('results', 3);
      expect(c.list()).toHaveLength(3);
      const entries = c.list('session-');
      expect(entries.map((entry) => entry.name).sort()).toEqual(['session-a', 'session-b']);
      for (const entry of entries) expect(entry.mtimeMs).toBeGreaterThan(0);
      c.remove('session-a');
      c.remove('session-a');
      expect(c.read('session-a', number)).toBeUndefined();
      expect(c.list('session-').map((entry) => entry.name)).toEqual(['session-b']);
    });
    test('invalid names never reach parsers or create entries or locks', () => {
      const c = cache();
      for (const name of [
        '',
        '.',
        '..',
        '.hidden',
        '../escape',
        '/absolute',
        'a/b',
        'a\\b',
        'a\n',
        'a\r',
        ' a',
        'a ',
        'a\0',
        'é',
      ]) {
        c.write(name, 1);
        expect(
          c.read(name, () => {
            throw new Error('must not run');
          }),
        ).toBeUndefined();
        expect(c.tryLock(name)).toBeUndefined();
        expect(() => c.remove(name)).not.toThrow();
      }
      expect(c.list()).toEqual([]);
      for (const name of ['results', 'session-123', 'a.b_c-0']) {
        c.write(name, 1);
        expect(c.read(name, number)).toBe(1);
      }
    });
    test('exclusive lock and repeated old release cannot remove a successor', () => {
      const c = cache();
      const release = c.tryLock('results');
      expect(release).toBeFunction();
      expect(c.tryLock('results')).toBeUndefined();
      present(release)();
      const successor = c.tryLock('results');
      expect(successor).toBeFunction();
      present(release)();
      expect(c.tryLock('results')).toBeUndefined();
      present(successor)();
    });
    test('watch reports all changed names and stops pending notifications', async () => {
      const c = cache();
      const names: Array<string | undefined> = [];
      const stop = c.watch((name) => names.push(name));
      stops.push(stop);
      c.write('results', 1);
      c.write('session-a', 2);
      await Bun.sleep(250);
      expect(names).toContain('results');
      expect(names).toContain('session-a');
      names.length = 0;
      c.remove('results');
      await Bun.sleep(250);
      expect(names).toContain('results');
      names.length = 0;
      c.write('results', 3);
      stop();
      await Bun.sleep(250);
      expect(names).toEqual([]);
    });
  });
}

test('file locks exclude a second instance and an independent process', () => {
  const dir = directory();
  const first = present(fileCache(dir));
  const second = present(fileCache(dir));
  const release = present(first.tryLock('results'));
  expect(second.tryLock('results')).toBeUndefined();
  const child = spawnSync(process.execPath, [
    '-e',
    `import { fileCache } from ${JSON.stringify(join(import.meta.dir, '../src/index.ts'))}; process.exit(fileCache(${JSON.stringify(dir)}).tryLock('results') ? 1 : 0);`,
  ]);
  expect(child.status).toBe(0);
  release();
  expect(second.tryLock('results')).toBeFunction();
});

test('age takeover preserves the successor when the original owner releases', () => {
  const dir = directory();
  let now = Date.now();
  const first = present(fileCache(dir, { now: () => now }));
  const second = present(fileCache(dir, { now: () => now }));
  const release = present(first.tryLock('results'));
  now += LOCK_STALE_MS;
  expect(second.tryLock('results')).toBeUndefined();
  now++;
  const nextRelease = second.tryLock('results');
  expect(nextRelease).toBeFunction();
  release();
  expect(first.tryLock('results')).toBeUndefined();
  present(nextRelease)();
  expect(first.tryLock('results')).toBeFunction();
});

test('dead PID takeover does not wait for age', () => {
  const dir = directory();
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0);
  writeFileSync(
    join(dir, 'results.lock'),
    JSON.stringify({ pid: child.pid, at: Date.now(), token: 'dead' }),
  );
  expect(present(fileCache(dir)).tryLock('results')).toBeFunction();
});

test('half-written locks use file age rather than immediate takeover', () => {
  const dir = directory();
  const now = Date.now();
  const path = join(dir, 'results.lock');
  writeFileSync(path, '{');
  const c = present(fileCache(dir, { now: () => now }));
  expect(c.tryLock('results')).toBeUndefined();
  const old = new Date(now - LOCK_STALE_MS - 1_000);
  utimesSync(path, old, old);
  expect(c.tryLock('results')).toBeFunction();
});

test('atomic replacement leaves only complete private JSON entries', () => {
  const dir = join(directory(), 'cache');
  const c = present(fileCache(dir));
  c.write('results', 1);
  const initial = statSync(join(dir, 'results.json'));
  c.write('results', 2);
  expect(statSync(join(dir, 'results.json')).ino).not.toBe(initial.ino);
  expect(JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))).toBe(2);
  expect(readdirSync(dir)).toEqual(['results.json']);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'results.json')).mode & 0o777).toBe(0o600);
  c.tryLock('results');
  expect(statSync(join(dir, 'results.lock')).mode & 0o777).toBe(0o600);
});

test('malformed entries and non-entry files are safely ignored', () => {
  const dir = directory();
  const c = present(fileCache(dir));
  writeFileSync(join(dir, 'bad.json'), '{');
  writeFileSync(join(dir, 'hidden.tmp'), '');
  writeFileSync(join(dir, '.hidden.json'), '');
  mkdirSync(join(dir, 'folder.json'));
  expect(c.read('bad', number)).toBeUndefined();
  expect(c.list().map((entry) => entry.name)).toEqual(['bad']);
});

test('watch sees another instance write and ignores locks and temporary files', async () => {
  const dir = directory();
  const first = present(fileCache(dir));
  const second = present(fileCache(dir));
  const names: Array<string | undefined> = [];
  stops.push(first.watch((name) => names.push(name)));
  second.tryLock('results');
  writeFileSync(join(dir, 'results.json.tmp'), '');
  await Bun.sleep(200);
  expect(names).toEqual([]);
  second.write('results', 5);
  await Bun.sleep(250);
  expect(names).toEqual(['results']);
});

test('unusable directories return undefined and openCache falls back to memory', () => {
  const path = join(directory(), 'file');
  writeFileSync(path, 'not a directory');
  expect(fileCache(path)).toBeUndefined();
  expect(fileCache(join(path, 'child'))).toBeUndefined();
  const c = openCache(path);
  c.write('results', 4);
  expect(c.read('results', number)).toBe(4);
});

test('filesystem failures after construction stay quiet', () => {
  const dir = directory();
  const c = present(fileCache(dir));
  rmSync(dir, { recursive: true });
  expect(c.read('results', number)).toBeUndefined();
  expect(() => c.write('results', 1)).not.toThrow();
  expect(() => c.remove('results')).not.toThrow();
  expect(c.list()).toEqual([]);
  expect(c.tryLock('results')).toBeUndefined();
  expect(() => c.watch(() => {})()).not.toThrow();
});

test('memory stale takeover preserves token ownership', () => {
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const c = memoryCache();
    const release = c.tryLock('results');
    expect(release).toBeFunction();
    now += LOCK_STALE_MS + 1;
    const successor = c.tryLock('results');
    expect(successor).toBeFunction();
    release?.();
    expect(c.tryLock('results')).toBeUndefined();
    successor?.();
    expect(c.tryLock('results')).toBeFunction();
  } finally {
    clock.mockRestore();
  }
});

test('openCache uses a usable directory rather than memory', () => {
  const dir = directory();
  const c = openCache(dir);
  c.write('results', 5);
  expect(fileCache(dir)?.read('results', number)).toBe(5);
});

test('memory instances do not share entries or locks', () => {
  const first = memoryCache();
  const second = memoryCache();
  first.write('results', 4);
  first.tryLock('results');
  expect(second.read('results', number)).toBeUndefined();
  expect(second.tryLock('results')).toBeFunction();
});
