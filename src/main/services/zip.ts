import { type FileHandle, open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal random-access ZIP reader. Both `.FCStd` and most CAD archives are
 * ZIP containers; reading just the central directory and the entries we need
 * avoids loading whole documents into memory.
 */

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

async function findEocd(
  handle: FileHandle,
  fileSize: number,
): Promise<{ offset: number; count: number } | null> {
  const maxBack = Math.min(fileSize, 66_000);
  const tail = await readAt(handle, fileSize - maxBack, maxBack);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      const count = tail.readUInt16LE(i + 10);
      const offset = tail.readUInt32LE(i + 16);
      return { offset, count };
    }
  }
  return null;
}

export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const eocd = await findEocd(handle, size);
    if (!eocd) return [];
    const entries: ZipEntry[] = [];
    let cursor = eocd.offset;
    for (let i = 0; i < eocd.count; i += 1) {
      const header = await readAt(handle, cursor, 46);
      if (header.length < 46 || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) break;
      const compressionMethod = header.readUInt16LE(10);
      const compressedSize = header.readUInt32LE(20);
      const uncompressedSize = header.readUInt32LE(24);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const localHeaderOffset = header.readUInt32LE(42);
      const nameBuffer = await readAt(handle, cursor + 46, nameLength);
      entries.push({
        name: nameBuffer.toString("utf8"),
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export async function readZipEntry(path: string, entryName: string): Promise<Buffer | null> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const eocd = await findEocd(handle, size);
    if (!eocd) return null;
    let cursor = eocd.offset;
    const wanted = entryName.toLowerCase();
    for (let i = 0; i < eocd.count; i += 1) {
      const header = await readAt(handle, cursor, 46);
      if (header.length < 46 || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) return null;
      const compressionMethod = header.readUInt16LE(10);
      const compressedSize = header.readUInt32LE(20);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      const localHeaderOffset = header.readUInt32LE(42);
      const nameBuffer = await readAt(handle, cursor + 46, nameLength);
      const name = nameBuffer.toString("utf8");
      if (name.toLowerCase() === wanted) {
        const local = await readAt(handle, localHeaderOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
        const localNameLength = local.readUInt16LE(26);
        const localExtraLength = local.readUInt16LE(28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const data = await readAt(handle, dataStart, compressedSize);
        if (compressionMethod === 0) return data;
        if (compressionMethod === 8) return inflateRawSync(data);
        return null;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Find the first entry whose name matches a suffix, case-insensitively. */
export async function findZipEntryName(
  path: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const entries = await listZipEntries(path);
  const match = entries.find((entry) => predicate(entry.name.toLowerCase()));
  return match?.name ?? null;
}

export function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;
}
