import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { env } from '../../config/env.js';

export interface StorageService {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
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
}

let instance: StorageService | null = null;

export const getStorage = (): StorageService => {
  if (!instance) {
    instance = new LocalStorageService(env.STORAGE_DIR);
  }
  return instance;
};

export const setStorageForTests = (next: StorageService | null): void => {
  instance = next;
};
