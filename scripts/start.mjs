import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireElectronExecutable } from "./electron-path.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const electron = requireElectronExecutable();

const child = spawn(electron, [root, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (error) => {
  console.error(`Failed to start Electron: ${error.message}`);
  process.exit(1);
});
