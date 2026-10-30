import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Entry {
  fingerprint: string;
  value: Promise<unknown>;
}

/**
 * Memoizes CLI reads per OpenSpec root (design D3). An entry is reused only
 * while the `openspec/` tree is unchanged, so any write invalidates it at once,
 * without waiting for the debounced watcher.
 */
export class ReadCache {
  readonly #entries = new Map<string, Entry>();

  async get<T>(root: string, key: string, read: () => Promise<T>): Promise<T> {
    const fingerprint = treeFingerprint(join(root, "openspec"));
    const fullKey = `${root}\0${key}`;
    const hit = this.#entries.get(fullKey);
    if (hit && hit.fingerprint === fingerprint) return hit.value as Promise<T>;

    const value = read();
    const entry: Entry = { fingerprint, value };
    this.#entries.set(fullKey, entry);
    // Never keep a failure: the next read retries the CLI.
    value.catch(() => {
      if (this.#entries.get(fullKey) === entry) this.#entries.delete(fullKey);
    });
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Hash of path, size and mtime of every entry under `dir` (symlinks are not followed). */
export function treeFingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (path: string) => {
    let names: string[];
    try {
      names = readdirSync(path).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const child = join(path, name);
      try {
        const st = lstatSync(child);
        parts.push(`${child}:${st.size}:${st.mtimeMs}`);
        if (st.isDirectory()) walk(child);
      } catch {
        // Removed while walking; the next read sees the new tree.
      }
    }
  };
  walk(dir);
  return Bun.hash(parts.join("\n")).toString(36);
}
