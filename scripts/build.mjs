import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const mainOnly = process.argv.includes("--main-only");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
};

async function buildMain() {
  await build({
    ...common,
    entryPoints: [`${root}src/main/app.ts`],
    outfile: `${root}dist/main/app.cjs`,
  });
}

async function buildPreload() {
  await build({
    ...common,
    entryPoints: [`${root}src/preload/index.ts`],
    outfile: `${root}dist/preload/index.cjs`,
  });
}

await rm(`${root}dist/main`, { recursive: true, force: true });
await rm(`${root}dist/preload`, { recursive: true, force: true });

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context({
    ...common,
    entryPoints: [`${root}src/main/app.ts`],
    outfile: `${root}dist/main/app.cjs`,
  });
  const pctx = await context({
    ...common,
    entryPoints: [`${root}src/preload/index.ts`],
    outfile: `${root}dist/preload/index.cjs`,
  });
  await ctx.watch();
  await pctx.watch();
  console.log("watching main + preload");
} else {
  await buildMain();
  await buildPreload();
  if (!mainOnly) {
    const { spawnSync } = await import("node:child_process");
    const res = spawnSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit" });
    if (res.status !== 0) process.exit(res.status ?? 1);
  }
}
