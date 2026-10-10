// File storage: private Vercel Blob in production (BLOB_READ_WRITE_TOKEN), local .blobdata/ folder otherwise.
// Files are never publicly addressable; the app streams them after its own access checks.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

export interface BlobStore {
  put(pathname: string, body: Buffer, contentType: string): Promise<void>;
  /** Null when the file doesn't exist. */
  get(pathname: string): Promise<{ body: Buffer; contentType: string } | null>;
  del(pathname: string): Promise<void>;
}

function vercelBlobStore(): BlobStore {
  return {
    async put(pathname, body, contentType) {
      const { put } = await import("@vercel/blob");
      await put(pathname, body, { access: "private", contentType, addRandomSuffix: false, allowOverwrite: true });
    },
    async get(pathname) {
      const { get } = await import("@vercel/blob");
      const res = await get(pathname, { access: "private", useCache: false }).catch(() => null);
      if (!res?.stream) return null;
      const body = Buffer.from(await new Response(res.stream).arrayBuffer());
      return { body, contentType: res.blob?.contentType ?? "application/octet-stream" };
    },
    async del(pathname) {
      const { del } = await import("@vercel/blob");
      await del(pathname).catch(() => undefined);
    },
  };
}

/** Local folder store for dev and e2e (gitignored). */
export function localBlobStore(root = path.join(/* turbopackIgnore: true */ process.cwd(), ".blobdata")): BlobStore {
  const file = (p: string) => {
    const resolved = path.join(root, p);
    if (!resolved.startsWith(root + path.sep)) throw new Error("Invalid blob path");
    return resolved;
  };
  return {
    async put(pathname, body, contentType) {
      await mkdir(path.dirname(file(pathname)), { recursive: true });
      await writeFile(file(pathname), body);
      await writeFile(file(pathname) + ".type", contentType);
    },
    async get(pathname) {
      try {
        const body = await readFile(file(pathname));
        const contentType = await readFile(file(pathname) + ".type", "utf8").catch(() => "application/octet-stream");
        return { body, contentType };
      } catch {
        return null;
      }
    },
    async del(pathname) {
      await rm(file(pathname), { force: true });
      await rm(file(pathname) + ".type", { force: true });
    },
  };
}

export function createMemoryBlobStore(): BlobStore & { files: Map<string, { body: Buffer; contentType: string }> } {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  return {
    files,
    async put(p, body, contentType) {
      files.set(p, { body, contentType });
    },
    async get(p) {
      return files.get(p) ?? null;
    },
    async del(p) {
      files.delete(p);
    },
  };
}

let override: BlobStore | null = null;
export function setBlobStore(store: BlobStore | null) {
  override = store;
}

export function getBlobStore(): BlobStore {
  if (override) return override;
  return process.env.BLOB_READ_WRITE_TOKEN ? vercelBlobStore() : localBlobStore();
}
