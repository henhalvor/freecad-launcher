import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appPaths } from "../../src/main/services/xdg.js";
import type { AppPaths } from "../../src/shared/types.js";

export async function makeTempDir(prefix = "fcl-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An AppPaths rooted entirely under a temp directory. */
export function testPaths(root: string): AppPaths {
  const base = appPaths({
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  });
  return { ...base, versionsDir: join(root, "data", "freecad-launcher", "versions") };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A fetch implementation that returns the given responses in order. */
export function sequenceFetch(
  responses: Array<Response | (() => Response | Promise<Response>)>,
): typeof fetch {
  let index = 0;
  return (async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error("no response");
    return typeof next === "function" ? await next() : next;
  }) as typeof fetch;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

export function streamResponse(chunks: Buffer[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}
