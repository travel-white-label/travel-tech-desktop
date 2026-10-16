// Electron main process of the desktop build.
//
// Two services run on the loopback interface, each on a free port, and a
// window opens on the admin:
//   admin         the Next.js standalone server, forked from Electron's Node
//   supplier-hub  started by hub-runner, which also hosts its Redis
//                 (in memory) and stops it when this process goes away
// The admin reaches supplier-hub at SUPPLIER_HUB_URL; supplier-hub calls the
// admin back at CORE_API_URL unless the env file names a hosted core-api.
//
// Each service's environment, lowest first:
//   1. launcher defaults           (soft: CORE_API_URL)
//   2. resources/env/<name>.json   (env/<channel>/<name>.env + CI secret, baked at build)
//   3. config.json[<name>]         (per install: minted secrets + anything a client adds)
//   4. launcher-owned values       (ports, paths, Redis) — always win
//
// Per-install state lives under the userData folder (or WL_ADMIN_DATA_DIR):
//   admin.db      the SQLite database (copied from the template on first launch)
//   config.json   per-service env, secrets minted on first launch
//   server.log    the admin's output and the launcher's own lines
//   hub.log       supplier-hub's and hub-runner's output
//   supplier-hub/ supplier-hub's working folder (templates, its storage/)

// Launched from a VS Code terminal (or any Electron-hosted shell), the process
// inherits ELECTRON_RUN_AS_NODE=1 and starts as plain Node with no `app`.
// Relaunch once without it so a double-click and a terminal launch behave alike.
if (process.env.ELECTRON_RUN_AS_NODE) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  require("child_process")
    .spawn(process.execPath, process.argv.slice(1), { env, detached: true, stdio: "ignore" })
    .unref();
  process.exit(0);
}

const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { URL } = require("url");

// The server binds to the IPv4 loopback, but every browser-facing URL says
// `localhost`: Next rewrites any loopback hostname in request.nextUrl to
// `localhost` (next/dist/server/web/next-url.js), so Auth.js redirects there
// after login — a window opened on 127.0.0.1 would lose its session cookie.
const BIND = "127.0.0.1";
const HOST = "localhost";
// Must match the SEED_SUPERADMIN_* values build.mjs seeds into template.db.
const FIRST_LOGIN = { email: "admin@example.com", password: "Admin-Change-Me-2026" };
const ADMIN = "white-label-admin";
const HUB = "supplier-hub";
const exe = process.platform === "win32" ? ".exe" : "";

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "stage");
const standaloneDir = path.join(resources, "standalone");
const hubDir = path.join(resources, "hub");
const templateDb = path.join(resources, "template.db");
// What build.mjs built: version, channel (test | production), target, sources.
const build = readJson(path.join(resources, "env", "build.json"));
const APP_NAME = build.channel === "test" ? "White-Label Admin Test" : "White-Label Admin";

// WL_ADMIN_DATA_DIR relocates everything (database, secrets, logs, browser
// profile and the single-instance lock) — for tests, and for a client who
// wants the data on another drive.
const userData = process.env.WL_ADMIN_DATA_DIR
  ? path.resolve(process.env.WL_ADMIN_DATA_DIR)
  : app.getPath("userData");
app.setPath("userData", userData);
const dbPath = path.join(userData, "admin.db");
const configPath = path.join(userData, "config.json");
const logPath = path.join(userData, "server.log");
const hubLogPath = path.join(userData, "hub.log");
const hubWorkDir = path.join(userData, "supplier-hub");

// The window talks to `localhost`, the server listens on 127.0.0.1: pin the
// name inside Chromium so it can never resolve to ::1 and be refused.
app.commandLine.appendSwitch("host-resolver-rules", `MAP ${HOST} ${BIND}`);

const SPLASH =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><title>${APP_NAME}</title>` +
      "<body style='margin:0;height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:#f6f6f8;color:#333'>" +
      `<div style='text-align:center'><div style='font-size:22px;font-weight:600;margin-bottom:10px'>${APP_NAME}</div>` +
      "<div>Starting the local server… the first launch after an install can take a minute.</div></div></body>",
  );

const children = [];
let quitting = false;
const startedAt = Date.now();

function logMain(line) {
  try {
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [main +${Date.now() - startedAt}ms] ${line}\n`,
    );
  } catch {
    // logging must never take the app down
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The env baked into this build for one service (build.mjs → resources/env). */
const bakedEnv = (name) => readJson(path.join(resources, "env", `${name}.json`));

/**
 * config.json holds one object per service. Secrets are minted once per
 * install and kept; any other key is passed through as env. An install from
 * before supplier-hub was bundled keeps its flat (admin-only) keys: they move
 * under the admin's name, so its AUTH_SECRET — and every setting sealed under
 * it — survives the upgrade.
 */
function loadConfig() {
  let config = readJson(configPath);
  if (Object.values(config).some((value) => typeof value === "string")) {
    config = { [ADMIN]: config };
  }
  const random = (bytes, encoding = "base64") => () => crypto.randomBytes(bytes).toString(encoding);
  const minted = {
    [ADMIN]: {
      AUTH_SECRET: random(32),
      B2C_API_SECRET: random(32),
      THEME_WEBHOOK_SECRET: random(32),
      AI_CHAT_VISITOR_SECRET: random(32, "hex"),
    },
    // Goravel refuses to boot unless APP_KEY is exactly 32 characters.
    [HUB]: { APP_KEY: random(16, "hex") },
  };
  for (const [service, keys] of Object.entries(minted)) {
    config[service] ??= {};
    for (const [key, make] of Object.entries(keys)) {
      if (typeof config[service][key] !== "string" || config[service][key] === "") {
        config[service][key] = make();
      }
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return config;
}

/** @returns {boolean} true when the database was just created from the template */
function ensureDatabase() {
  if (fs.existsSync(dbPath)) return false;
  fs.copyFileSync(templateDb, dbPath);
  return true;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, BIND, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startChild(label, command, args, { cwd, env, log }) {
  logMain(`starting ${label}`);
  const fd = fs.openSync(log, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill();
    }
  }
}

async function waitForHealth(url, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`It exited with code ${child.exitCode} while starting.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("It did not become ready in time.");
}

function startAdmin({ config, adminPort, hubPort }) {
  const env = {
    ...bakedEnv(ADMIN),
    ...config[ADMIN],
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(adminPort),
    HOSTNAME: BIND,
    DB_PROVIDER: "sqlite",
    DATABASE_URL: `file:${dbPath.replace(/\\/g, "/")}`,
    AUTH_URL: `http://${HOST}:${adminPort}`,
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    SUPPLIER_HUB_URL: `http://${BIND}:${hubPort}/supplierhub`,
    // server-entry.js exits when this pid disappears, so a crash of the
    // launcher never leaves an orphaned server holding the database.
    DESKTOP_PARENT_PID: String(process.pid),
  };
  // A desktop install is a local file database by definition.
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;
  return startChild(ADMIN, process.execPath, [path.join(standaloneDir, "server-entry.js")], {
    cwd: standaloneDir,
    env,
    log: logPath,
  });
}

function startHub({ config, adminPort, hubPort }) {
  // Goravel reads resources/views and writes storage/ relative to its cwd,
  // which must be writable: a fresh copy of the templates on every launch.
  fs.rmSync(path.join(hubWorkDir, "resources"), { recursive: true, force: true });
  fs.cpSync(path.join(hubDir, "resources"), path.join(hubWorkDir, "resources"), { recursive: true });
  return freePort().then((redisPort) =>
    startChild(HUB, path.join(hubDir, `hub-runner${exe}`), [], {
      cwd: hubWorkDir,
      log: hubLogPath,
      env: {
        CORE_API_URL: `http://${BIND}:${adminPort}`,
        ...bakedEnv(HUB),
        ...config[HUB],
        HUB_BIN: path.join(hubDir, `supplierhub${exe}`),
        DESKTOP_PARENT_PID: String(process.pid),
        APP_HOST: BIND,
        APP_PORT: String(hubPort),
        APP_URL: `http://${BIND}:${hubPort}`,
        REDIS_HOST: BIND,
        REDIS_PORT: String(redisPort),
        REDIS_PASSWORD: "",
        QUEUE_CONNECTION: "redis",
      },
    }),
  );
}

function fail(error) {
  logMain(`fatal: ${error.stack ?? error.message}`);
  dialog.showErrorBox(APP_NAME, `${error.message}\n\nLogs: ${logPath}`);
  quitting = true;
  stopChildren();
  app.exit(1);
}

// One window, one server: SQLite has a single writer, so a second instance
// would only fight the first for the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      fs.mkdirSync(hubWorkDir, { recursive: true });
      logMain(
        `launch (packaged=${app.isPackaged}, data=${userData}, ` +
          `build=${build.version ?? "?"} ${build.channel ?? "?"} ${build.target ?? "?"})`,
      );

      // The window comes first, with a splash, so a cold start is never a
      // blank wait: the server takes a few seconds to load, and a lot longer
      // on the first launch after an install while the antivirus scans it.
      const win = new BrowserWindow({
        width: 1440,
        height: 900,
        title: APP_NAME,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      // Links that leave the app (report downloads, external sites) open in the
      // browser — web and mail links only. Anything else (file:, ms-msdt:,
      // search-ms:, …) would hand an attacker-chosen URL to an OS protocol
      // handler, so it is dropped.
      const openOutside = (url) => {
        let protocol = "";
        try {
          protocol = new URL(url).protocol;
        } catch {
          return;
        }
        if (["http:", "https:", "mailto:"].includes(protocol)) void shell.openExternal(url);
      };
      win.webContents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: "deny" };
      });
      // The window itself only ever shows the splash and the local server;
      // anything else is opened outside rather than loaded in the app window.
      let appOrigin = null;
      win.webContents.on("will-navigate", (event, url) => {
        if (url === SPLASH) return;
        let origin = "";
        try {
          origin = new URL(url).origin;
        } catch {
          // fall through: not a URL the window may load
        }
        if (appOrigin && origin === appOrigin) return;
        event.preventDefault();
        openOutside(url);
      });
      await win.loadURL(SPLASH);

      const config = loadConfig();
      const firstRun = ensureDatabase();
      const ports = { config, adminPort: await freePort(), hubPort: await freePort() };

      // supplier-hub is not fatal: the admin still runs without it, and its
      // supplier calls report the hub as unreachable. hub.log says why.
      const hub = await startHub(ports);
      hub.on("exit", (code) => {
        if (!quitting) logMain(`supplier-hub stopped (exit code ${code}), see ${hubLogPath}`);
      });
      // supplier-hub registers /health at the root, outside its supplierhub prefix.
      waitForHealth(`http://${BIND}:${ports.hubPort}/health`, hub).then(
        () => logMain("supplier-hub healthy"),
        (error) => logMain(`supplier-hub not ready: ${error.message}`),
      );

      const server = startAdmin(ports);
      server.on("exit", (code) => {
        if (!quitting) fail(new Error(`The server stopped unexpectedly (exit code ${code}).`));
      });
      await waitForHealth(`http://${BIND}:${ports.adminPort}/api/health`, server).catch((error) => {
        throw new Error(`The server did not start. ${error.message}`);
      });
      logMain("server healthy");

      appOrigin = `http://${HOST}:${ports.adminPort}`;
      await win.loadURL(`${appOrigin}/`);
      logMain("window loaded");

      if (firstRun) {
        await dialog.showMessageBox(win, {
          type: "info",
          title: APP_NAME,
          message: "Welcome — a new database was created for this computer.",
          detail:
            `Sign in with\n  ${FIRST_LOGIN.email}\n  ${FIRST_LOGIN.password}\n\n` +
            "You will be asked to choose a new password straight away.\n\n" +
            `Data folder: ${userData}`,
        });
      }
    } catch (error) {
      fail(error);
    }
  });
}

app.on("window-all-closed", () => {
  logMain("window closed, quitting");
  app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  stopChildren();
});
