import { existsSync, realpathSync } from "node:fs";

/**
 * Resolve an Electron runtime that can actually run on this machine.
 *
 * The `electron` npm package only supplies TypeScript types here; its bundled
 * binary is a generic glibc build that cannot start on NixOS (missing
 * libdrm/libgbm/...). The runtime must come from Nix. npm puts
 * `node_modules/.bin` on PATH inside scripts, so that shim is skipped.
 */
export function resolveElectronExecutable() {
  const explicit = process.env.ELECTRON_EXECUTABLE_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    if (dir.replaceAll("\\", "/").includes("node_modules/.bin")) continue;
    const candidate = `${dir}/electron`;
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

export function requireElectronExecutable() {
  const bin = resolveElectronExecutable();
  if (bin) return bin;

  console.error(
    [
      "No usable Electron runtime found.",
      "",
      "The Electron binary downloaded by npm cannot start on NixOS, so the",
      "launcher is meant to run with the Nix-provided Electron. Enter the dev",
      "shell first:",
      "",
      "  nix develop",
      "  npm run dev",
      "",
      "Or point at a Nix Electron explicitly:",
      "",
      '  ELECTRON_EXECUTABLE_PATH="$(nix eval --raw nixpkgs#electron)/bin/electron" npm run dev',
      "",
    ].join("\n"),
  );
  process.exit(1);
}
