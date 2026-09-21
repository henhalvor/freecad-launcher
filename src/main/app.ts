import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, Menu, app, protocol, session, shell } from "electron";
import { EVENTS } from "../shared/channels.js";
import { executeLaunchCommand } from "./cli-launch.js";
import { type CliCommand, HELP_TEXT, appArgsFromArgv, parseArgv } from "./cli.js";
import { AppContext } from "./context.js";
import { registerIpc } from "./ipc.js";
import { decodeMediaUrl } from "./services/markdown.js";
import { fetchMedia } from "./services/media.js";

const DEV_SERVER_URL = process.env.FREECAD_LAUNCHER_DEV_SERVER?.trim() || null;
const MEDIA_SCHEME = "freecad-media";

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
  },
]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: freecad-media:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.github.com https://github.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

const DEV_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${DEV_SERVER_URL ?? "http://localhost:5199"}`,
  `style-src 'self' 'unsafe-inline' ${DEV_SERVER_URL ?? "http://localhost:5199"}`,
  "img-src 'self' data: blob: freecad-media:",
  "font-src 'self' data:",
  `connect-src 'self' ${DEV_SERVER_URL ?? "http://localhost:5199"} ws://localhost:5199 https://api.github.com`,
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;
let quitting = false;
let contextReady: Promise<AppContext> | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: "#12161c",
    title: "FreeCAD Launcher",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [],
    },
  });

  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }

  return window;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [{ label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => quitApp() }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function quitApp(): void {
  quitting = true;
  app.quit();
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showWindow(navigate?: { view?: string; error?: string }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (navigate) mainWindow.webContents.send(EVENTS.navigate, navigate);
}

async function getContext(): Promise<AppContext> {
  if (!contextReady) {
    contextReady = AppContext.create().then((ctx) => {
      context = ctx;
      ctx.broadcast = broadcast;
      return ctx;
    });
  }
  return contextReady;
}

async function runCommand(
  command: CliCommand,
  source: "initial" | "second-instance",
): Promise<void> {
  if (command.kind === "gui") {
    showWindow();
    return;
  }
  if (command.kind === "help") {
    process.stdout.write(HELP_TEXT);
    quitApp();
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(`${app.getVersion()}\n`);
    quitApp();
    return;
  }

  try {
    const ctx = await getContext();
    const result = await executeLaunchCommand(ctx, command);
    if (!result.ok && source === "initial") {
      showWindow({ view: "versions", error: result.error ?? "FreeCAD failed to launch" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[freecad-launcher] ${message}\n`);
    showWindow({ view: "versions", error: message });
  }
}

async function registerMediaProtocol(ctx: AppContext): Promise<void> {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.pathname.replace(/^\//, "");
      const original = decodeMediaUrl(encoded);
      if (!original) return new Response("Not found", { status: 404 });
      const media = await fetchMedia(ctx.paths, original);
      if (!media) return new Response("Not found", { status: 404 });
      const body = await readFile(media.path);
      return new Response(body, {
        headers: { "content-type": media.contentType, "cache-control": "max-age=86400" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

async function bootstrap(): Promise<void> {
  const ctx = await getContext();
  await registerMediaProtocol(ctx);

  const csp = DEV_SERVER_URL ? DEV_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  mainWindow = createWindow();
  buildMenu();

  registerIpc(ctx, {
    getWindow: () => mainWindow,
    devServerUrl: DEV_SERVER_URL,
    onQuit: () => quitApp(),
  });

  mainWindow.once("ready-to-show", () => {
    if (initialCommand.kind === "gui") showWindow();
  });

  await runCommand(initialCommand, "initial");
}

let initialCommand: CliCommand = { kind: "gui" };

function parseArgsSafely(argv: string[]): CliCommand {
  try {
    return parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return { kind: "gui" };
  }
}

const rawArgs = appArgsFromArgv(process.argv, app.getAppPath());
initialCommand = parseArgsSafely(rawArgs);

const isDev = DEV_SERVER_URL !== null;

if (initialCommand.kind === "help" || initialCommand.kind === "version") {
  // These are pure CLI invocations: never take the single-instance lock.
  app.whenReady().then(() => runCommand(initialCommand, "initial"));
} else if (!isDev && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // In dev, skip the single-instance lock. Otherwise a stale launcher from a
  // previous run keeps serving the UI and the fresh build silently exits.
  if (!isDev) {
    app.on("second-instance", (_event, argv) => {
      const command = parseArgsSafely(appArgsFromArgv(argv, app.getAppPath()));
      if (command.kind === "gui") {
        showWindow();
        return;
      }
      void runCommand(command, "second-instance");
    });
  }

  app.on("window-all-closed", () => {
    // Keep the process alive so FreeCAD sessions can still be tracked.
  });

  app.on("before-quit", () => {
    quitting = true;
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      process.stderr.write(
        `Failed to start FreeCAD Launcher: ${(error as Error).stack ?? error}\n`,
      );
      quitting = true;
      app.quit();
    });
}
