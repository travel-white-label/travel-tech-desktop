// Builds the desktop app for the OS and CPU this machine has:
//
//   node build.mjs                          test channel, sources from sources.json
//   node build.mjs --channel production
//   node build.mjs --src supplier-hub=../supplier-hub   use a local checkout as-is
//   node build.mjs --doctor                 only check the tools
//   node build.mjs --install                macOS: also replace the app in /Applications
//
// Each source is fetched into work/<name> at the ref sources.json names for
// the channel, built with env/<channel>/<name>.env plus the ENV_<NAME> secret,
// staged into stage/, and packaged by electron-builder into dist/.
//
// Native modules (argon2, libsql, sharp, Prisma) are installed for the host,
// so every OS/CPU builds on its own machine — CI runs one job per target.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const desktop = path.dirname(fileURLToPath(import.meta.url));
const stage = path.join(desktop, "stage");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const { sources } = JSON.parse(fs.readFileSync(path.join(desktop, "sources.json"), "utf8"));

// --- arguments and the host ---------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const channel = flag("--channel") ?? process.env.CHANNEL ?? "test";
if (!["production", "test"].includes(channel)) throw new Error(`Unknown channel "${channel}"`);
const localSources = Object.fromEntries(
  argv.flatMap((arg, i) => (argv[i - 1] === "--src" ? [arg.split("=")] : [])),
);

const platform = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!platform || !arch) throw new Error(`Unsupported host ${process.platform}/${process.arch}`);
const goEnv = {
  CGO_ENABLED: "0",
  GOOS: { mac: "darwin", win: "windows", linux: "linux" }[platform],
  GOARCH: arch === "x64" ? "amd64" : "arm64",
};
const exe = platform === "win" ? ".exe" : "";

// Keep in sync with FIRST_LOGIN in main.js: the first-launch dialog shows these,
// and the seed marks the account mustResetPassword so they only work once.
const SEED = {
  SEED_SUPERADMIN_EMAIL: "admin@example.com",
  SEED_SUPERADMIN_NAME: "Super Admin",
  SEED_SUPERADMIN_USERNAME: "admin",
  SEED_SUPERADMIN_PASSWORD: "Admin-Change-Me-2026",
};

// --- helpers --------------------------------------------------------------------
// Children never see the repo token or the ENV_* secrets: dependency install
// scripts run with this environment.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "GH_TOKEN" && !k.startsWith("ENV_")),
);

function run(command, args, { cwd = desktop, env = {}, capture = false, quiet = false } = {}) {
  if (!quiet) console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32" && command === "npx", // resolves npx.cmd
    env: { ...childEnv, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return capture ? result.stdout.trim() : "";
}

function step(title) {
  console.log(`\n=== ${title}`);
}

function doctor() {
  step(`Host: ${platform}-${arch}, channel: ${channel}`);
  const tools = [
    ["git", ["--version"]],
    ["node", ["--version"], (v) => Number(v.match(/v(\d+)/)?.[1]) >= 22, "22+"],
    ["npx", ["--version"]],
    ["go", ["version"], (v) => /go1\.(2[4-9]|[3-9]\d)/.test(v), "1.24+"],
  ];
  let ok = true;
  for (const [tool, args, check = () => true, need = ""] of tools) {
    const result = spawnSync(tool, args, { encoding: "utf8", shell: process.platform === "win32" });
    const version = (result.stdout || "").trim().split("\n")[0];
    const good = result.status === 0 && check(version);
    ok &&= good;
    console.log(`  ${good ? "ok     " : "MISSING"} ${tool.padEnd(5)} ${version || "not found"}${good ? "" : `  (need ${need || "it"})`}`);
  }
  if (!fs.existsSync(path.join(desktop, "node_modules", "electron-builder"))) {
    console.log("  MISSING electron-builder  (run npm ci in this folder)");
    ok = false;
  }
  if (!ok) throw new Error("Install the missing tools above, then build again.");
}

/** Fetches a source at its ref into work/<name> (or uses a --src checkout as-is). */
function fetchSource(source) {
  if (localSources[source.name]) {
    const dir = path.resolve(localSources[source.name]);
    return { dir, ref: "local", commit: run("git", ["rev-parse", "HEAD"], { cwd: dir, capture: true, quiet: true }) };
  }
  const ref = typeof source.ref === "string" ? source.ref : source.ref[channel];
  if (!ref) throw new Error(`sources.json: ${source.name} has no ref for "${channel}"`);
  const dir = path.join(desktop, "work", source.name);
  // The token travels as a header in the environment, never in a URL, an
  // argument or .git/config, so it cannot show up in a log.
  const auth = process.env.GH_TOKEN
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`,
      }
    : {};
  const git = (...args) => run("git", args, { cwd: dir, env: auth });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", `https://github.com/${source.repo}.git`);
  }
  git("fetch", "-q", "--depth", "1", "origin", ref);
  git("checkout", "-q", "--force", "FETCH_HEAD");
  git("clean", "-ffdxq", "-e", "node_modules");
  return { dir, ref, commit: run("git", ["rev-parse", "HEAD"], { cwd: dir, capture: true, quiet: true }) };
}

/**
 * env/<channel>/<name>.env, then the gitignored <name>.secret.env, then the ENV_<NAME>
 * secret over them; empty means unset.
 */
function loadEnv(name) {
  const read = (file) => {
    const p = path.join(desktop, "env", channel, file);
    return fs.existsSync(p) ? parseEnv(fs.readFileSync(p, "utf8")) : {};
  };
  const merged = {
    ...read(`${name}.env`),
    ...read(`${name}.secret.env`),
    ...parseEnv(process.env[`ENV_${name.toUpperCase().replace(/-/g, "_")}`] ?? ""),
  };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ""));
}

// --- builders, one per source name ---------------------------------------------------
const builders = {
  "white-label-admin"(dir, env) {
    const pnpm = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).packageManager;
    const scratch = path.join(stage, "template-build.db");
    const templateDb = path.join(stage, "template.db");
    const buildEnv = {
      ...env,
      ...SEED,
      DB_PROVIDER: "sqlite",
      DATABASE_URL: `file:${scratch.replace(/\\/g, "/")}`,
      ADMIN_DESKTOP_BUILD: "1", // next.config.ts: output "standalone"
      NEXT_TELEMETRY_DISABLED: "1",
      HUSKY: "0",
    };
    const sh = (...args) => run("npx", ["-y", pnpm, ...args], { cwd: dir, env: buildEnv });

    sh("install", "--frozen-lockfile");
    // The Prisma client is generated for one engine: SQLite on a desktop.
    sh("exec", "prisma", "generate");
    // template.db: schema + permissions + roles + customer roles + reference data.
    sh("exec", "prisma", "db", "push", "--skip-generate");
    sh("run", "-s", "seed");
    sh("run", "-s", "seed-customer-roles");
    sh("run", "-s", "import-reference-data");
    sh("exec", "next", "build");

    step("Staging the admin server");
    const standalone = path.join(stage, "standalone");
    const copy = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    copy(path.join(dir, ".next", "standalone"), standalone);
    // Standalone output deliberately leaves these two out.
    copy(path.join(dir, ".next", "static"), path.join(standalone, ".next", "static"));
    copy(path.join(dir, "public"), path.join(standalone, "public"));
    fs.copyFileSync(path.join(desktop, "server-entry.js"), path.join(standalone, "server-entry.js"));
    // pnpm's hoisted links (.pnpm/node_modules/*) come along even when the
    // trace left their package out; a dangling link breaks macOS signing.
    for (const entry of fs.readdirSync(standalone, { recursive: true, withFileTypes: true })) {
      const link = path.join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink() && !fs.existsSync(link)) fs.rmSync(link);
    }
    // The launcher supplies every runtime variable; a traced-in .env would
    // carry the build machine's values into the installer.
    for (const name of fs.readdirSync(standalone)) {
      if (name.startsWith(".env")) fs.rmSync(path.join(standalone, name));
    }

    // VACUUM INTO folds the WAL into one compact file — the only safe way to
    // copy a WAL-mode database.
    const { createClient } = createRequire(path.join(dir, "package.json"))("@libsql/client");
    const client = createClient({ url: `file:${scratch.replace(/\\/g, "/")}` });
    return client
      .execute(`VACUUM INTO '${templateDb.replace(/\\/g, "/").replace(/'/g, "''")}'`)
      .then(() => client.close());
  },

  "supplier-hub"(dir) {
    const hub = path.join(stage, "hub");
    const go = (args, cwd) => run("go", args, { cwd, env: goEnv });
    go(["build", "-trimpath", "-ldflags=-s -w", "-o", path.join(hub, `supplierhub${exe}`), "."], dir);
    // Goravel loads its templates from resources/views relative to its cwd.
    fs.cpSync(path.join(dir, "resources"), path.join(hub, "resources"), { recursive: true });
    go(["build", "-trimpath", "-ldflags=-s -w", "-o", path.join(hub, `hub-runner${exe}`), "."], path.join(desktop, "hub-runner"));
  },
};

// --- the build -----------------------------------------------------------------------
doctor();
if (argv.includes("--doctor")) process.exit(0);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "env"), { recursive: true });

const version = process.env.DESKTOP_VERSION || pkg.version;
const lock = { version, channel, target: `${platform}-${arch}`, sources: [] };
for (const source of sources) {
  const build = builders[source.name];
  if (!build) throw new Error(`sources.json lists "${source.name}" but build.mjs has no builder for it`);
  step(`${source.name} (${source.repo})`);
  const { dir, ref, commit } = fetchSource(source);
  const env = loadEnv(source.name);
  await build(dir, env);
  fs.writeFileSync(path.join(stage, "env", `${source.name}.json`), JSON.stringify(env, null, 2));
  lock.sources.push({ name: source.name, repo: source.repo, ref, commit });
  console.log(`${source.name}: ${ref} @ ${commit}`);
}
fs.writeFileSync(path.join(stage, "env", "build.json"), JSON.stringify(lock, null, 2));

step(`electron-builder (${platform}-${arch}, ${channel} ${version})`);
const { build, Platform, Arch } = require("electron-builder");
const test = channel === "test";
const config = {
  ...pkg.build,
  // A test build is a separate app: its own name, id and data folder, so it can
  // be installed next to production and never opens production's admin.db.
  ...(test && {
    appId: `${pkg.build.appId}.test`,
    productName: `${pkg.build.productName} Test`,
    artifactName: pkg.build.artifactName.replace("white-label-admin-", "white-label-admin-test-"),
    portable: { artifactName: pkg.build.portable.artifactName.replace("white-label-admin-", "white-label-admin-test-") },
  }),
  extraMetadata: { version, ...(test && { name: `${pkg.name}-test` }) },
};
fs.rmSync(path.join(desktop, "dist"), { recursive: true, force: true });
await build({
  targets: { mac: Platform.MAC, win: Platform.WINDOWS, linux: Platform.LINUX }[platform].createTarget(null, Arch[arch]),
  config,
  publish: "never",
});
fs.copyFileSync(path.join(stage, "env", "build.json"), path.join(desktop, "dist", `build-${platform}-${arch}.json`));

if (argv.includes("--install") && platform === "mac") {
  const dir = path.join(desktop, "dist", arch === "arm64" ? "mac-arm64" : "mac");
  const appName = fs.readdirSync(dir).find((f) => f.endsWith(".app"));
  const target = path.join("/Applications", appName);
  step(`Installing ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  run("ditto", [path.join(dir, appName), target]);
}

step("Done");
for (const name of fs.readdirSync(path.join(desktop, "dist"))) {
  const file = path.join(desktop, "dist", name);
  if (fs.statSync(file).isFile()) console.log(`  dist/${name}  (${(fs.statSync(file).size / 1024 / 1024).toFixed(0)} MB)`);
}
