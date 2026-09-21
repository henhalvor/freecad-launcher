import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireElectronExecutable } from "./electron-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const devServerUrl = process.env.FREECAD_LAUNCHER_DEV_SERVER ?? "http://localhost:5199";
const electronBin = requireElectronExecutable();

// Build main + preload once; the renderer is served by Vite below.
const build = spawnSync("node", ["scripts/build.mjs", "--main-only"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const vite = spawn("npx", ["vite"], { cwd: root, stdio: "inherit" });

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) return false;
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

let electron = null;

function shutdown(code) {
  vite.kill("SIGTERM");
  if (electron) electron.kill("SIGTERM");
  process.exit(code ?? 0);
}

vite.on("exit", (code) => shutdown(code));
process.on("SIGINT", () => shutdown(0));

const ready = await waitForServer(devServerUrl);
if (!ready) {
  console.error(`Vite did not become ready at ${devServerUrl}.`);
  shutdown(1);
}

const electronStartedAt = Date.now();
electron = spawn(electronBin, [root], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, FREECAD_LAUNCHER_DEV_SERVER: devServerUrl },
});

electron.on("exit", (code) => {
  if (Date.now() - electronStartedAt < 3000) {
    console.error(
      [
        "",
        "Electron exited almost immediately. A previously started launcher may",
        "still be running — it hides instead of quitting, so it can keep serving",
        "an old build.",
        "",
        "Quit it (Ctrl+Q in its window, or Settings → Quit launcher), then run",
        "`npm run dev` again.",
        "",
      ].join("\n"),
    );
  }
  shutdown(code);
});
electron.on("error", (error) => {
  console.error(`Failed to start Electron: ${error.message}`);
  shutdown(1);
});
