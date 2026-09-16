import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadVerifiedExampleCache(files, { directory, assets }) {
  const entries = await Promise.all([...new Set(files.map(file => file.url))].map(async url => {
    const locked = assets[url];
    if (!locked || !/^[a-f0-9]{64}$/.test(locked.sha256)) {
      throw new Error(`Missing locked SHA-256 for cached example: ${url}`);
    }
    const path = join(directory, createHash('sha256').update(url).digest('hex'));
    let body;
    try {
      body = await readFile(path);
    } catch (cause) {
      throw new Error(`Cannot read cached example ${url} at ${path}; cache mode does not fall back to the network`, { cause });
    }
    if (createHash('sha256').update(body).digest('hex') !== locked.sha256 || body.length !== locked.bytes) {
      throw new Error(`Cached example checksum or size mismatch: ${url}`);
    }
    return [url, { body, contentType: locked.contentType || 'application/octet-stream' }];
  }));
  return new Map(entries);
}
