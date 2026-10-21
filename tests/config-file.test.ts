import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { ConfigFile, type ConfigFs, parseConfigText, readConfig } from '../src/config-file.ts';

const directories: string[] = [];
function fixture(text?: string) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-core-kit-config-'));
  directories.push(directory);
  const path = join(directory, 'settings.json');
  if (text !== undefined) fs.writeFileSync(path, text);
  return { directory, path };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const DenyList = Type.Object(
  { tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) },
  { additionalProperties: false },
);

describe('parseConfigText', () => {
  test('accepts an object and freezes it deeply', () => {
    const outcome = parseConfigText('{"a":{"b":[1]}}');
    expect(outcome).toEqual({ status: 'value', value: { a: { b: [1] } } });
    if (outcome.status !== 'value') throw new Error('expected a value');
    expect(Object.isFrozen(outcome.value)).toBe(true);
    expect(Object.isFrozen((outcome.value.a as { b: number[] }).b)).toBe(true);
  });

  test('strips a byte order mark', () => {
    expect(parseConfigText('\uFEFF{"a":1}')).toEqual({ status: 'value', value: { a: 1 } });
  });

  test.each(['null', '[]', 'true', '12', '"text"'])('rejects a non-object root: %s', (text) => {
    expect(parseConfigText(text)).toEqual({ status: 'invalid', reason: 'must be a JSON object' });
  });

  test('reports malformed JSON', () => {
    const outcome = parseConfigText('{');
    expect(outcome.status).toBe('invalid');
    expect(outcome.status === 'invalid' && outcome.reason).toStartWith('invalid JSON (');
  });

  test('reports every schema problem with its path', () => {
    const outcome = parseConfigText('{"tools":["a",""],"extra":1}', DenyList);
    expect(outcome).toEqual({
      status: 'invalid',
      reason:
        'root: must not have additional properties (extra); tools.1: must not have fewer than 1 characters',
    });
  });

  test('keeps an own __proto__ key as data', () => {
    const outcome = parseConfigText('{"__proto__":{"polluted":true}}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(outcome.status === 'value' && Object.hasOwn(outcome.value, '__proto__')).toBe(true);
  });
});

describe('readConfig', () => {
  test('a missing file is missing, not an error', () => {
    expect(readConfig(join(fixture().directory, 'absent.json'))).toEqual({ status: 'missing' });
  });

  test('validates against the schema', () => {
    const { path } = fixture('{"tools":["read"]}');
    expect(readConfig(path, { schema: DenyList })).toEqual({
      status: 'value',
      value: { tools: ['read'] },
    });
  });

  test('an unreadable file is invalid with the cause', () => {
    const { path } = fixture('{}');
    const outcome = readConfig(path, {
      fs: {
        ...fs,
        readFileSync() {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      } as ConfigFs,
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'cannot read (denied)' });
  });
});

describe('ConfigFile.read', () => {
  test('returns the same outcome object until the file changes', () => {
    const { path } = fixture('{"a":1}');
    const file = new ConfigFile(path);
    const first = file.read();
    expect(file.read()).toBe(first);
    fs.writeFileSync(path, '{"a":22}');
    const second = file.read();
    expect(second).not.toBe(first);
    expect(second).toEqual({ status: 'value', value: { a: 22 } });
  });

  test('stats once per read and reads the file only when it changed', () => {
    const { path } = fixture('{}');
    const calls: string[] = [];
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        statSync(target: string) {
          calls.push('stat');
          return fs.statSync(target);
        },
        readFileSync(target: string, encoding: 'utf8') {
          calls.push('read');
          return fs.readFileSync(target, encoding);
        },
      } as ConfigFs,
    });
    file.read();
    file.read();
    expect(calls).toEqual(['stat', 'read', 'stat']);
  });

  test('caches an invalid file until it changes, and forgets a deleted one', () => {
    const { path } = fixture('{');
    const file = new ConfigFile(path);
    const broken = file.read();
    expect(broken.status).toBe('invalid');
    expect(file.read()).toBe(broken);
    fs.rmSync(path);
    expect(file.read()).toEqual({ status: 'missing' });
  });

  test('a stat failure other than missing is invalid', () => {
    const { path } = fixture('{}');
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        statSync() {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      } as ConfigFs,
    });
    expect(file.read()).toEqual({ status: 'invalid', reason: 'cannot read (denied)' });
  });
});

describe('ConfigFile.update', () => {
  test('creates a missing file with mode 0600 and keeps unknown keys on later edits', () => {
    const { path } = fixture();
    const file = new ConfigFile(path);
    file.update((root) => ({ ...root, tools: { echo: 'off' } }));
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path, '{"future":42,"tools":{"echo":"off"}}');
    file.update((root) => {
      (root.tools as Record<string, string>).read = 'on';
      return root;
    });
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({
      future: 42,
      tools: { echo: 'off', read: 'on' },
    });
    expect(fs.readFileSync(path, 'utf8')).toEndWith('}\n');
  });

  test('keeps an existing file mode', () => {
    const { path } = fixture('{}');
    fs.chmodSync(path, 0o640);
    new ConfigFile(path).update((root) => ({ ...root, a: 1 }));
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
  });

  test('the next read sees the update', () => {
    const { path } = fixture('{"a":1}');
    const file = new ConfigFile(path);
    file.read();
    file.update(() => ({ a: 2 }));
    expect(file.read()).toEqual({ status: 'value', value: { a: 2 } });
  });

  test.each(['{', '[]', 'null'])('refuses to overwrite an unparseable file: %s', (text) => {
    const { path } = fixture(text);
    expect(() => new ConfigFile(path).update(() => ({ a: 1 }))).toThrow('Refusing to overwrite');
    expect(fs.readFileSync(path, 'utf8')).toBe(text);
  });

  test('refuses to overwrite an unreadable file', () => {
    const { path } = fixture('{}');
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        statSync() {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      } as ConfigFs,
    });
    expect(() => file.update(() => ({ a: 1 }))).toThrow('Refusing to overwrite');
    expect(fs.readFileSync(path, 'utf8')).toBe('{}');
  });

  test('rejects an edit that breaks the schema, writing nothing', () => {
    const { path } = fixture('{"tools":["read"]}');
    const file = new ConfigFile(path, { schema: DenyList });
    expect(() => file.update(() => ({ tools: [''] }))).toThrow('would make');
    expect(fs.readFileSync(path, 'utf8')).toBe('{"tools":["read"]}');
  });

  test('rejects an edit that returns a non-object', () => {
    const { path } = fixture('{}');
    expect(() => new ConfigFile(path).update(() => [] as never)).toThrow('JSON object');
  });

  test.each(['write', 'chmod', 'rename'])(
    'a %s failure keeps the original and removes the temporary file',
    (operation) => {
      const { path, directory } = fixture('{"a":1}');
      const file = new ConfigFile(path, {
        fs: {
          ...fs,
          writeFileSync(fd: number, data: string, encoding: 'utf8') {
            if (operation === 'write') {
              fs.writeFileSync(fd, 'partial');
              throw new Error('write failed');
            }
            fs.writeFileSync(fd, data, encoding);
          },
          fchmodSync(fd: number, mode: number) {
            if (operation === 'chmod') throw new Error('chmod failed');
            fs.fchmodSync(fd, mode);
          },
          renameSync(from: string, to: string) {
            if (operation === 'rename') throw new Error('rename failed');
            fs.renameSync(from, to);
          },
        } as ConfigFs,
      });
      expect(() => file.update(() => ({ a: 2 }))).toThrow(`${operation} failed`);
      expect(fs.readFileSync(path, 'utf8')).toBe('{"a":1}');
      expect(fs.readdirSync(directory)).toEqual(['settings.json']);
    },
  );

  test('an exclusive temporary-file collision is neither removed nor overwritten', () => {
    const { path, directory } = fixture('{}');
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        openSync(temp: string, flags: 'wx', mode: number) {
          fs.writeFileSync(temp, 'other writer');
          return fs.openSync(temp, flags, mode);
        },
      } as ConfigFs,
    });
    expect(() => file.update(() => ({ a: 1 }))).toThrow();
    const other = fs.readdirSync(directory).find((name) => name.endsWith('.tmp'));
    expect(other).toBeDefined();
    expect(fs.readFileSync(join(directory, other ?? ''), 'utf8')).toBe('other writer');
    expect(fs.readFileSync(path, 'utf8')).toBe('{}');
  });

  test('a concurrent change restarts the edit on the new content', () => {
    const { path } = fixture('{}');
    let once = true;
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        writeFileSync(fd: number, data: string, encoding: 'utf8') {
          fs.writeFileSync(fd, data, encoding);
          if (once) {
            once = false;
            fs.writeFileSync(path, '{"future":42}');
          }
        },
      } as ConfigFs,
    });
    file.update((root) => ({ ...root, tools: { echo: 'off' } }));
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({
      future: 42,
      tools: { echo: 'off' },
    });
  });

  test('gives up after three concurrent changes and cleans temporaries', () => {
    const { path, directory } = fixture('{}');
    let writes = 0;
    const file = new ConfigFile(path, {
      fs: {
        ...fs,
        writeFileSync(fd: number, data: string, encoding: 'utf8') {
          fs.writeFileSync(fd, data, encoding);
          fs.writeFileSync(path, JSON.stringify({ concurrent: ++writes }));
        },
      } as ConfigFs,
    });
    expect(() => file.update((root) => ({ ...root, a: 1 }))).toThrow('changed repeatedly');
    expect(writes).toBe(3);
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({ concurrent: 3 });
    expect(fs.readdirSync(directory)).toEqual(['settings.json']);
  });
});
