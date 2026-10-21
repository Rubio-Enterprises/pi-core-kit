import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { type AtomicWriteFs, writeAtomic } from './atomic-write.ts';

/** A config file's top-level JSON object. */
export type ConfigRoot = Record<string, unknown>;

/**
 * The outcome of reading a config file. `invalid` covers unreadable files, malformed JSON,
 * a non-object root and schema violations; `reason` says which, without the path.
 * A `value` is deeply frozen.
 */
export type ConfigRead<T = ConfigRoot> =
  | { readonly status: 'missing' }
  | { readonly status: 'value'; readonly value: T }
  | { readonly status: 'invalid'; readonly reason: string };

export interface ConfigFs extends AtomicWriteFs {
  statSync(path: string): { mtimeMs: number; size: number; mode: number };
  readFileSync(path: string, encoding: 'utf8'): string;
  mkdirSync(path: string, options: { recursive: true }): unknown;
}

export interface ConfigOptions<S extends TSchema | undefined = undefined> {
  /** Validates the whole root. Omit it to accept any JSON object. */
  schema?: S;
  /** Filesystem to use; defaults to `node:fs`. For tests. */
  fs?: ConfigFs;
}

type Shape<S> = S extends TSchema ? Static<S> : ConfigRoot;

const MISSING: ConfigRead<never> = Object.freeze({ status: 'missing' });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function isRoot(value: unknown): value is ConfigRoot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Schema errors as `path: message`, one per problem, joined with `; `. */
export function describeErrors(schema: TSchema, value: unknown): string {
  const problems: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    if (error.keyword === 'boolean') continue;
    const where =
      error.instancePath === '' ? 'root' : error.instancePath.slice(1).replaceAll('/', '.');
    const extra =
      error.keyword === 'additionalProperties'
        ? ` (${(error.params as { additionalProperties?: string[] }).additionalProperties?.join(', ')})`
        : '';
    problems.push(`${where}: ${error.message}${extra}`);
  }
  return problems.join('; ') || 'does not match the schema';
}

/** Parses config text: strips a BOM, requires a JSON object, then applies the schema. */
export function parseConfigText<S extends TSchema | undefined = undefined>(
  text: string,
  schema?: S,
): ConfigRead<Shape<S>> {
  let root: unknown;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { status: 'invalid', reason: `invalid JSON (${message(error)})` };
  }
  if (!isRoot(root)) return { status: 'invalid', reason: 'must be a JSON object' };
  if (schema && !Value.Check(schema, root))
    return { status: 'invalid', reason: describeErrors(schema, root) };
  return { status: 'value', value: freeze(root) as Shape<S> };
}

/** Reads a config file once. A missing file is `missing`, never an error. */
export function readConfig<S extends TSchema | undefined = undefined>(
  path: string,
  options: ConfigOptions<S> = {},
): ConfigRead<Shape<S>> {
  const fs = options.fs ?? nodeFs;
  try {
    return parseConfigText(fs.readFileSync(path, 'utf8'), options.schema);
  } catch (error) {
    if (isMissing(error)) return MISSING;
    return { status: 'invalid', reason: `cannot read (${message(error)})` };
  }
}

interface Snapshot {
  root: ConfigRoot | undefined;
  text: string | undefined;
  mode: number;
  mtimeMs: number;
  size: number;
}

/**
 * One config file: cached reads and safe updates.
 *
 * `read` re-reads only when the file's modification time or size changes, and returns the same
 * outcome object until then, so callers can skip re-deriving state by comparing identity.
 */
export class ConfigFile<S extends TSchema | undefined = undefined> {
  readonly path: string;
  private readonly fs: ConfigFs;
  private readonly schema: S | undefined;
  private cache?: { stamp: string; outcome: ConfigRead<Shape<S>> };

  constructor(path: string, options: ConfigOptions<S> = {}) {
    this.path = path;
    this.fs = options.fs ?? nodeFs;
    this.schema = options.schema;
  }

  read(): ConfigRead<Shape<S>> {
    let stamp: string;
    try {
      const stat = this.fs.statSync(this.path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      this.cache = undefined;
      if (isMissing(error)) return MISSING;
      return { status: 'invalid', reason: `cannot read (${message(error)})` };
    }
    if (this.cache?.stamp === stamp) return this.cache.outcome;
    const outcome = readConfig(this.path, { fs: this.fs, schema: this.schema });
    if (outcome.status === 'missing') this.cache = undefined;
    else this.cache = { stamp, outcome };
    return outcome;
  }

  /**
   * Edits the file safely. `edit` receives a mutable copy of the current root (`{}` when the
   * file is missing) and returns the new root. It may run more than once, so keep it pure.
   *
   * Refuses to overwrite a file it cannot read or parse. Re-reads just before replacing the
   * file and starts over if it changed meanwhile, giving up after three attempts. Keeps the
   * file's mode (new files get 0600), writes through an exclusive temporary file and an atomic
   * rename, and validates the result against the schema before writing.
   */
  update(edit: (root: Shape<S>) => Shape<S>): void {
    this.cache = undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.tryUpdate(edit)) return;
    }
    throw new Error(`Config ${this.path} changed repeatedly while writing; retry the edit`);
  }

  private snapshot(): Snapshot {
    let text: string;
    let stat: { mtimeMs: number; size: number; mode: number };
    try {
      stat = this.fs.statSync(this.path);
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (isMissing(error))
        return { root: undefined, text: undefined, mode: 0o600, mtimeMs: 0, size: 0 };
      throw new Error(`Refusing to overwrite ${this.path}: cannot read (${message(error)})`, {
        cause: error,
      });
    }
    const parsed = parseConfigText(text);
    if (parsed.status !== 'value')
      throw new Error(
        `Refusing to overwrite ${this.path}: ${parsed.status === 'invalid' ? parsed.reason : 'missing'}`,
      );
    return {
      root: parsed.value,
      text,
      mode: stat.mode & 0o7777,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  }

  private tryUpdate(edit: (root: Shape<S>) => Shape<S>): boolean {
    const before = this.snapshot();
    const draft = structuredClone(before.root ?? {}) as Shape<S>;
    const next: unknown = edit(draft);
    if (!isRoot(next)) throw new Error(`Edit must return a JSON object for ${this.path}`);
    if (this.schema && !Value.Check(this.schema, next))
      throw new Error(`Edit would make ${this.path} invalid: ${describeErrors(this.schema, next)}`);
    this.fs.mkdirSync(dirname(this.path), { recursive: true });
    return writeAtomic(
      this.fs,
      this.path,
      `${JSON.stringify(next, null, 2)}\n`,
      before.mode,
      () => {
        const current = this.snapshot();
        return (
          current.text === before.text &&
          current.mode === before.mode &&
          current.mtimeMs === before.mtimeMs &&
          current.size === before.size
        );
      },
    );
  }
}
