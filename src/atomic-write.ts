/**
 * Internal to pi-core-kit: shared by `config-file` and `session-cache`, not exported.
 */
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteFs {
  openSync(path: string, flags: 'wx', mode: number): number;
  writeFileSync(fd: number, data: string, encoding: 'utf8'): void;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

/**
 * Writes `data` to an exclusive temporary file beside `path`, then renames it over `path`.
 * `beforeRename` may veto the rename by returning false. Returns whether the rename happened.
 * A temporary file this call created is always removed when the rename does not happen.
 */
export function writeAtomic(
  fs: AtomicWriteFs,
  path: string,
  data: string,
  mode: number,
  beforeRename: () => boolean = () => true,
): boolean {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(temp, 'wx', mode);
  let renamed = false;
  try {
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    if (!beforeRename()) return false;
    fs.renameSync(temp, path);
    renamed = true;
    return true;
  } finally {
    if (!renamed) fs.unlinkSync(temp);
  }
}
