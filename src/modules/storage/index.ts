import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { env } from '../../config/env.js';

export interface StorageService {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every stored key under a prefix, used by maintenance scripts. */
  list(prefix: string): Promise<string[]>;
}

const assertSafeKey = (key: string): string => {
  const normalized = normalize(key).replace(/\\/g, '/');
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new Error('Invalid storage key');
  }
  return normalized;
};

export class LocalStorageService implements StorageService {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const safeKey = assertSafeKey(key);
    const fullPath = resolve(join(this.root, safeKey));
    if (!fullPath.startsWith(this.root)) {
      throw new Error('Invalid storage key');
    }
    return fullPath;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const safePrefix = assertSafeKey(prefix).replace(/\/$/, '');
    const root = this.pathFor(safePrefix);
    const keys: string[] = [];

    const walk = async (directory: string, relative: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(directory, entry.name), key);
        else if (entry.isFile()) keys.push(`${safePrefix}/${key}`);
      }
    };

    await walk(root, '');
    return keys;
  }
}

let instance: StorageService | null = null;

export const getStorage = (): StorageService => {
  if (!instance) {
    instance = new LocalStorageService(env.STORAGE_DIR);
  }
  return instance;
};
