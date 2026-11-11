import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  closeSync,
  type FSWatcher,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './atomic-write.ts';

/** A lock older than this may be taken over even if its process is alive. */
export const LOCK_STALE_MS = 30_000;

/** Quiet period after the last directory event before the reconciliation scan runs. */
const SCAN_DEBOUNCE_MS = 250;
/** A steady stream of events delays a pending scan by at most this, rate limit aside. */
const SCAN_MAX_WAIT_MS = 2_000;
/**
 * Minimum spacing between two full directory scans of one watch. Named events already cover the
 * normal path with one stat, so the scan is a safety net. Many live sessions keep a shared
 * directory busy, and every watcher would otherwise rescan it every few seconds.
 */
const SCAN_MIN_INTERVAL_MS = 10_000;

export interface SessionCache {
  /** Returns undefined for missing, unreadable or parser-rejected entries. */
  read<T>(name: string, parse: (raw: unknown) => T | undefined): T | undefined;
  /** Best-effort atomic JSON replacement, mode 0600. Never throws. */
  write(name: string, value: unknown): void;
  /** Missing entries are a no-op. Never throws. */
  remove(name: string): void;
  list(prefix?: string): Array<{ name: string; mtimeMs: number }>;
  /** Returns an ownership-checked release function, or undefined when held. */
  tryLock(name: string): (() => void) | undefined;
  /** Debounced (~100 ms), unref'd notifications; undefined means an unknown entry. */
  watch(onChange: (name: string | undefined) => void): () => void;
}

function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name === name.trim();
}

function notifications(onChange: (name: string | undefined) => void) {
  const names = new Set<string | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    changed(name: string | undefined) {
      names.add(name);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const pending = [...names];
        names.clear();
        for (const entry of pending) onChange(entry);
      }, 100);
      timer.unref?.();
    },
    stop() {
      clearTimeout(timer);
      names.clear();
    },
  };
}

/** Per-process JSON cache with no cross-process sharing. */
export function memoryCache(): SessionCache {
  const entries = new Map<string, { json: string; mtimeMs: number }>();
  const locks = new Map<string, { token: symbol; at: number }>();
  const listeners = new Set<ReturnType<typeof notifications>>();
  const changed = (name: string) => {
    for (const listener of listeners) listener.changed(name);
  };
  return {
    read(name, parse) {
      if (!validName(name)) return;
      try {
        const entry = entries.get(name);
        return entry ? parse(JSON.parse(entry.json)) : undefined;
      } catch {
        return;
      }
    },
    write(name, value) {
      if (!validName(name)) return;
      try {
        const json = JSON.stringify(value);
        if (json === undefined) return;
        entries.set(name, { json, mtimeMs: Date.now() });
        changed(name);
      } catch {
        // Serialization failures leave the previous value intact
      }
    },
    remove(name) {
      if (validName(name) && entries.delete(name)) changed(name);
    },
    list(prefix = '') {
      return [...entries]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, entry]) => ({
          name,
          mtimeMs: entry.mtimeMs,
        }));
    },
    tryLock(name) {
      if (!validName(name)) return;
      const held = locks.get(name);
      if (held && Date.now() - held.at <= LOCK_STALE_MS) return;
      const token = Symbol();
      locks.set(name, { token, at: Date.now() });
      return () => {
        if (locks.get(name)?.token === token) locks.delete(name);
      };
    },
    watch(onChange) {
      const listener = notifications(onChange);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        listener.stop();
      };
    },
  };
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Creates `dir` with mode 0700 and probes writability; undefined when unusable. */
export function fileCache(dir: string, options?: { now?: () => number }): SessionCache | undefined {
  const now = options?.now ?? Date.now;
  const probe = join(dir, `.probe-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    unlinkSync(probe);
  } catch {
    try {
      unlinkSync(probe);
    } catch {
      // The directory may not exist
    }
    return undefined;
  }

  const entryPath = (name: string) => join(dir, `${name}.json`);
  const lockPath = (name: string) => join(dir, `${name}.lock`);
  const lockIsStale = (path: string): boolean => {
    try {
      const { pid, at } = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; at?: unknown };
      return (
        typeof at !== 'number' ||
        !Number.isFinite(at) ||
        now() - at > LOCK_STALE_MS ||
        !processAlive(pid)
      );
    } catch {
      // A half-written lock is judged by age, not its incomplete payload
      try {
        return now() - statSync(path).mtimeMs > LOCK_STALE_MS;
      } catch {
        return true;
      }
    }
  };

  return {
    read(name, parse) {
      if (!validName(name)) return;
      try {
        return parse(JSON.parse(readFileSync(entryPath(name), 'utf8')));
      } catch {
        return;
      }
    },
    write(name, value) {
      if (!validName(name)) return;
      try {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') return;
        writeAtomic(nodeFs, entryPath(name), json, 0o600);
      } catch {
        // Serialization or I/O failure leaves the previous entry intact
      }
    },
    remove(name) {
      if (!validName(name)) return;
      try {
        unlinkSync(entryPath(name));
      } catch {
        // Missing or inaccessible entries are best effort
      }
    },
    list(prefix = '') {
      const entries: Array<{ name: string; mtimeMs: number }> = [];
      try {
        for (const filename of readdirSync(dir)) {
          if (!filename.endsWith('.json')) continue;
          const name = filename.slice(0, -5);
          if (!(validName(name) && name.startsWith(prefix))) continue;
          try {
            const stat = statSync(entryPath(name));
            if (stat.isFile()) entries.push({ name, mtimeMs: stat.mtimeMs });
          } catch {
            // Another process may remove an entry during enumeration
          }
        }
      } catch {
        // The cache directory may have been removed
      }
      return entries;
    },
    tryLock(name) {
      if (!validName(name)) return;
      const path = lockPath(name);
      const token = randomBytes(16).toString('hex');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = openSync(path, 'wx', 0o600);
          try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: now() }));
          } finally {
            closeSync(fd);
          }
          return () => {
            try {
              const held = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
              if (held.token === token) unlinkSync(path);
            } catch {
              // Already gone or replaced by an incomplete lock
            }
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
          if (attempt > 0 || !lockIsStale(path)) return;
          try {
            unlinkSync(path);
          } catch {
            // The exclusive-open retry decides concurrent takeover
          }
        }
      }
      return;
    },
    watch(onChange) {
      const listener = notifications(onChange);
      const signature = (name: string): string | undefined => {
        try {
          const stat = statSync(entryPath(name));
          return stat.isFile()
            ? `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
            : undefined;
        } catch {
          // Entries may disappear while being examined
          return undefined;
        }
      };
      const scan = () => {
        const entries = new Map<string, string>();
        try {
          for (const filename of readdirSync(dir)) {
            const name = filename.slice(0, -5);
            if (!(filename.endsWith('.json') && validName(name))) continue;
            const current = signature(name);
            if (current !== undefined) entries.set(name, current);
          }
        } catch {
          // Watching remains best effort if the directory becomes inaccessible
        }
        return entries;
      };
      let known = scan();
      const record = (name: string, current: string | undefined) => {
        if (known.get(name) === current) return;
        if (current === undefined) known.delete(name);
        else known.set(name, current);
        listener.changed(name);
      };

      // Directory events can coalesce several changed files into one filename, so every
      // event also asks for a full scan. The scan is trailing-debounced and rate-limited to
      // one per SCAN_MIN_INTERVAL_MS, however many events arrive; a coalesced change can be
      // reported that much later than the event that hid it.
      let stopped = false;
      let scanTimer: ReturnType<typeof setTimeout> | undefined;
      let lastScanAt = Number.NEGATIVE_INFINITY;
      let pendingSince: number | undefined;
      const cancelScan = () => {
        clearTimeout(scanTimer);
        scanTimer = undefined;
        pendingSince = undefined;
      };
      const requestScan = () => {
        if (stopped) return;
        const at = now();
        pendingSince ??= at;
        const due = Math.max(
          Math.min(at + SCAN_DEBOUNCE_MS, pendingSince + SCAN_MAX_WAIT_MS),
          lastScanAt + SCAN_MIN_INTERVAL_MS,
        );
        clearTimeout(scanTimer);
        scanTimer = setTimeout(
          () => {
            cancelScan();
            lastScanAt = now();
            const current = scan();
            for (const entry of new Set([...known.keys(), ...current.keys()])) {
              if (known.get(entry) !== current.get(entry)) listener.changed(entry);
            }
            known = current;
          },
          // The clamp bounds the wait if the injected clock moves backwards
          Math.min(SCAN_MIN_INTERVAL_MS, Math.max(0, due - at)),
        );
        scanTimer.unref?.();
      };

      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(dir, (_event, filename) => {
          if (stopped) return;
          if (filename) {
            const file = String(filename);
            if (!file.endsWith('.json')) return;
            const name = file.slice(0, -5);
            if (!validName(name)) return;
            // One stat of the named file settles added, changed and removed
            record(name, signature(name));
          } else {
            listener.changed(undefined);
          }
          requestScan();
        });
        watcher.on('error', () => {
          cancelScan();
          watcher?.close();
        });
        watcher.unref?.();
      } catch {
        // Polling callers can continue when watching is unavailable
      }
      return () => {
        stopped = true;
        cancelScan();
        listener.stop();
        watcher?.close();
      };
    },
  };
}

/** Uses memory only when the directory is unusable at construction time. */
export function openCache(dir: string, options?: { now?: () => number }): SessionCache {
  return fileCache(dir, options) ?? memoryCache();
}
