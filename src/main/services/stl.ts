import { readFile } from "node:fs/promises";
import type { MeshData } from "../../shared/types.js";

export const DEFAULT_MAX_TRIANGLES = 8000;

function detectBinary(buffer: Buffer): boolean {
  if (buffer.length < 84) return false;
  const triangles = buffer.readUInt32LE(80);
  return buffer.length === 84 + triangles * 50;
}

function parseBinary(buffer: Buffer, maxTriangles: number): MeshData {
  const total = Math.min(buffer.readUInt32LE(80), maxTriangles);
  const positions: number[] = [];
  let offset = 84;
  for (let i = 0; i < total; i += 1) {
    // Skip the 12-byte normal, read the 3 vertices.
    for (let v = 0; v < 3; v += 1) {
      const base = offset + 12 + v * 12;
      positions.push(
        buffer.readFloatLE(base),
        buffer.readFloatLE(base + 4),
        buffer.readFloatLE(base + 8),
      );
    }
    offset += 50;
  }
  return { positions, triangleCount: total };
}

function parseAscii(text: string, maxTriangles: number): MeshData {
  const positions: number[] = [];
  let count = 0;
  const vertexRe = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let match: RegExpExecArray | null = vertexRe.exec(text);
  while (match && count < maxTriangles) {
    positions.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (positions.length % 9 === 0) count += 1;
    match = vertexRe.exec(text);
  }
  return { positions: positions.slice(0, count * 9), triangleCount: count };
}

/** Parse an STL file into flat triangle positions, capped for preview use. */
export async function parseStl(
  path: string,
  maxTriangles = DEFAULT_MAX_TRIANGLES,
): Promise<MeshData> {
  const buffer = await readFile(path);
  if (detectBinary(buffer)) return parseBinary(buffer, maxTriangles);
  return parseAscii(buffer.toString("utf8"), maxTriangles);
}

export function parseStlBuffer(buffer: Buffer, maxTriangles = DEFAULT_MAX_TRIANGLES): MeshData {
  if (detectBinary(buffer)) return parseBinary(buffer, maxTriangles);
  return parseAscii(buffer.toString("utf8"), maxTriangles);
}

/** Serialize a mesh to a binary STL buffer for the external F3D viewer. */
export function meshToStlBuffer(mesh: MeshData, header = "freecad-launcher"): Buffer {
  const triangles = Math.floor(mesh.positions.length / 9);
  const buffer = Buffer.alloc(84 + triangles * 50);
  buffer.write(header.slice(0, 79).padEnd(80, " "), 0, "ascii");
  buffer.writeUInt32LE(triangles, 80);
  let offset = 84;
  for (let t = 0; t < triangles; t += 1) {
    const base = t * 9;
    const ax = mesh.positions[base]!;
    const ay = mesh.positions[base + 1]!;
    const az = mesh.positions[base + 2]!;
    const bx = mesh.positions[base + 3]!;
    const by = mesh.positions[base + 4]!;
    const bz = mesh.positions[base + 5]!;
    const cx = mesh.positions[base + 6]!;
    const cy = mesh.positions[base + 7]!;
    const cz = mesh.positions[base + 8]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const value of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      buffer.writeFloatLE(value, offset);
      offset += 4;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  return buffer;
}

/** Compute a bounding box and center for preview camera framing. */
export function meshBounds(mesh: MeshData): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0]!)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
