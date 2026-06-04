import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import type { FileProvider } from '@floway-dev/platform';

// Filesystem-backed FileProvider. Every key resolves to a path under `root`,
// so listKeys / deletePrefix walk the filesystem rather than maintaining a
// separate index. Keys use forward-slash POSIX separators (matching R2's
// surface) and are translated to native path segments on the way in/out so
// the same key reads identically on Windows and POSIX hosts.
export class FsFileProvider implements FileProvider {
  constructor(private readonly root: string) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  async listKeys(prefix: string): Promise<string[]> {
    const dir = this.pathFor(prefix);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(entry.parentPath, entry.name);
      keys.push(relative(this.root, fullPath).split(sep).join('/'));
    }
    return keys;
  }

  private pathFor(key: string): string {
    return join(this.root, ...key.split('/'));
  }
}
