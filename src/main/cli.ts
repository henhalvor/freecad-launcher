import { resolve } from "node:path";
import type { ReleaseChannel } from "../shared/types.js";

export type CliCommand =
  | { kind: "gui" }
  | {
      kind: "launch";
      channel: ReleaseChannel | null;
      version: string | null;
      singleInstance: boolean;
      files: string[];
    }
  | { kind: "help" }
  | { kind: "version" };

export const HELP_TEXT = `FreeCAD Launcher

Usage:
  freecad-launcher
  freecad-launcher launch --channel <stable|weekly> [--single-instance] [--] FILE...
  freecad-launcher launch --version RELEASE_ID [--single-instance] [--] FILE...

Options:
  --channel <stable|weekly>  Launch the default build for a channel
  --version RELEASE_ID       Launch a specific installed release
  --single-instance          Open files in an already-running FreeCAD
  --help                     Show this help
  --version                  Show the launcher version (without a subcommand)
`;

/**
 * Parse the launcher argv (without the executable / Electron path). Unknown
 * flags are rejected rather than silently ignored, so desktop entries cannot
 * introduce surprising behaviour.
 */
export function parseArgv(argv: string[]): CliCommand {
  const args = argv.filter((arg) => arg !== ".");
  if (args.length === 0) return { kind: "gui" };

  // `--launcher-help` / `--launcher-version` are what the Nix wrapper rewrites
  // `--help` / `--version` into, because Electron/Chromium claim those flags.
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "--launcher-help")
    return { kind: "help" };

  if (args[0] !== "launch") {
    if (args[0] === "--version" || args[0] === "-v" || args[0] === "--launcher-version") {
      return { kind: "version" };
    }
    // A bare file argument opens the GUI with that project selected.
    if (!args[0]!.startsWith("-")) {
      return { kind: "launch", channel: null, version: null, singleInstance: false, files: args };
    }
    throw new Error(`Unknown argument: ${args[0]}`);
  }

  let channel: ReleaseChannel | null = null;
  let version: string | null = null;
  let singleInstance = false;
  const files: string[] = [];
  const rest = args.slice(1);
  let i = 0;
  let afterSeparator = false;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (afterSeparator) {
      files.push(arg);
      i += 1;
      continue;
    }
    if (arg === "--") {
      afterSeparator = true;
      i += 1;
      continue;
    }
    if (arg === "--single-instance") {
      singleInstance = true;
      i += 1;
      continue;
    }
    if (arg === "--channel") {
      const value = rest[i + 1];
      if (value !== "stable" && value !== "weekly")
        throw new Error("--channel must be stable or weekly");
      channel = value;
      i += 2;
      continue;
    }
    if (arg === "--version" || arg === "--release-id") {
      const value = rest[i + 1];
      if (!value) throw new Error("--version requires a release id");
      version = value;
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    files.push(arg);
    i += 1;
  }

  if (!channel && !version) throw new Error("launch requires --channel or --version");
  return { kind: "launch", channel, version, singleInstance, files };
}

/**
 * Strip the Electron executable, the app directory, and Chromium switches so
 * only app arguments remain. `electron <app-dir> …` puts the app path at
 * argv[1], which must not be mistaken for a file to open.
 */
export function appArgsFromArgv(argv: string[], appPath?: string): string[] {
  const normalizedApp = appPath ? resolve(appPath) : null;
  return argv
    .slice(1)
    .filter(
      (arg) =>
        arg !== "." &&
        !(normalizedApp && resolve(arg) === normalizedApp) &&
        !arg.startsWith("--no-") &&
        !arg.startsWith("--enable-") &&
        arg !== "--disable-gpu",
    )
    .filter((arg) => !arg.startsWith("--remote-debugging-port"));
}
