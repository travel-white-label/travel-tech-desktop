# white-label-desktop

Builds the white-label platform as one installable desktop app for **Windows,
macOS and Linux**, and publishes it as GitHub releases of this repo.

The applications live in their own repositories and know nothing about this
one. A build pulls each of them at a pinned ref, builds it, and packages the
lot with Electron. Every environment value they run with is decided here.

| Repo                                                       | What runs on the desktop                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [white-label-admin](https://github.com/sirazul-ibos/white-label-admin)   | Next.js standalone server + its SQLite database              |
| [supplier-hub](https://github.com/travel-white-label/supplier-hub)       | Go binary, with an in-memory Redis provided by `hub-runner/` |

## Installing (for clients)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/travel-white-label/white-label-desktop/main/installer/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/travel-white-label/white-label-desktop/main/installer/install.ps1 | iex
```

The installer checks the computer — OS, CPU (including Apple Silicon behind
Rosetta), OS version, glibc and package format on Linux, disk, memory, an
existing install, a running copy — then downloads the matching file from the
latest release, verifies it against `checksums.txt` and installs it. Options:
`CHANNEL=test` (latest test pre-release), `VERSION=v1.2.0`, `FORMAT=AppImage`
(Linux). Upgrades never touch the data folder.

| Target      | Files in a release                                   |
| ----------- | ---------------------------------------------------- |
| Windows x64 | `…-win-x64.exe` (installer), `…-win-x64-portable.exe` |
| macOS arm64 / x64 | `…-mac-<arch>.dmg`, `…-mac-<arch>.zip`         |
| Linux x64 / arm64 | `….AppImage`, `….deb`                          |

## Releasing

```bash
git tag v1.2.0        && git push origin v1.2.0         # production release
git tag v1.2.0-test.1 && git push origin v1.2.0-test.1  # test pre-release
```

`.github/workflows/release.yml` builds the five targets, each on its own OS
(native modules — argon2, libsql, sharp, Prisma — are installed for the
machine that builds), then publishes the release with `checksums.txt` and a
note listing the exact commit of every source. *Run workflow* in the Actions
tab builds the artifacts without publishing.

## Channels and environment

A build is **test** or **production**. Each channel has:

- **refs** — `sources.json`: the branch, tag or commit of every repo.
- **env** — `env/<channel>/<repo>.env`: committed, **non-secret** values.
- **secrets** — the GitHub Environment named after the channel, one secret per
  repo, `ENV_<REPO>` (`ENV_WHITE_LABEL_ADMIN`, `ENV_SUPPLIER_HUB`), holding
  dotenv text. Merged over the env file at build time.

A test build is a separate app (*White-Label Admin Test*, its own app id and
data folder), so it installs next to production and never opens its database.

At run time each service's env is layered, lowest first: launcher defaults →
the baked env → that install's `config.json` → values the launcher owns
(ports, database path, Redis). The env files list which keys are owned.

> **Everything baked into the app is readable by anyone who downloads it.**
> CI secrets keep values out of this public repo's history, not out of the
> installer. Keep paid supplier keys and anything else that must stay private
> on a server you control.

Repository secret `SOURCES_TOKEN`: a fine-grained token (or GitHub App token)
with read access to every repo in `sources.json`. It is passed to git as a
header through the environment and never reaches the builds' install scripts.

## Local development (no build)

```bash
npm ci                                  # once, in this folder
(cd ../white-label-admin && pnpm install)   # once
# once: its database (prisma/dev.db with DATABASE_URL=file:../dev.db) — schema + seed
(cd ../white-label-admin && pnpm generate && pnpm exec prisma db push --skip-generate \
  && pnpm seed && pnpm seed-customer-roles && pnpm import-reference-data)
npm run dev
```

Runs the sibling checkouts `../white-label-admin` and `../supplier-hub` as
they are (set `WL_ADMIN_SRC` / `WL_HUB_SRC` in a gitignored `desktop/.env` to point elsewhere) — nothing is staged
or packaged:

- **admin** — `next dev` with hot reload, using the checkout's own `.env` and
  database. The launcher only sets the port, `AUTH_URL` and the supplier-hub
  wiring.
- **supplier-hub** — `go build` into `work/dev-hub/` on each launch (Go
  caches, so it's quick), run from the checkout. Restart the app to pick up Go
  changes.

Both also get the non-empty values of `env/test/<repo>.env`. Logs and
`config.json` go to `work/dev-data/`.

## Building locally

Needs git, Node 22+, Go 1.24+ and `npm ci` in this folder; `npm run doctor`
checks them. A build targets the machine it runs on.

```bash
npm ci
node build.mjs                                   # test channel, sources fetched into work/
node build.mjs --channel production
node build.mjs --src supplier-hub=../supplier-hub   # use a local checkout as-is
```

Locally, git uses your own GitHub credentials; set `GH_TOKEN` to use a token.
Output goes to `dist/`. Secrets for a local build: export `ENV_<REPO>`.

`--src` builds a checkout in place: for the admin that regenerates its Prisma
client for SQLite and writes `prisma/schema/datasource.prisma` — run
`pnpm generate` there afterwards to go back to your dev engine.

Try a build without touching an installed copy:

```bash
WL_ADMIN_DATA_DIR=/tmp/wl-test "dist/mac-arm64/White-Label Admin Test.app/Contents/MacOS/White-Label Admin Test"
```

## How the app runs

```
Electron (main.js)
 ├─ admin         127.0.0.1:<free port>   resources/standalone/server-entry.js
 └─ hub-runner    resources/hub/hub-runner
     ├─ Redis (miniredis, in memory)      127.0.0.1:<free port>
     └─ supplierhub                        127.0.0.1:<free port>
```

- The admin gets `SUPPLIER_HUB_URL`; supplier-hub gets `CORE_API_URL` pointing
  at the admin unless its env file names a hosted core-api.
- Both children watch the launcher's pid and exit when it disappears, so a
  crash never leaves a server holding the database.
- supplier-hub failing does not stop the admin; see `hub.log`.

Per-install data folder (`%APPDATA%`, `~/Library/Application Support`,
`~/.config`, then `white-label-admin-desktop[-test]`):

| File            | Purpose                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `admin.db`      | The database, copied from the bundled template on first launch.             |
| `config.json`   | `{ "white-label-admin": {…}, "supplier-hub": {…} }` — minted secrets plus any extra env for that service. |
| `server.log`    | Admin output and the launcher's lines.                                       |
| `hub.log`       | supplier-hub and hub-runner output.                                          |
| `supplier-hub/` | supplier-hub's working folder (templates, `storage/`).                       |

First launch: sign in as `admin@example.com` / `Admin-Change-Me-2026`; the
account must change its password straight away.

## Adding a repo

1. Add it to `sources.json`.
2. Add a builder under its name in `build.mjs` that stages its output in `stage/`.
3. Start it in `main.js` (its env: `bakedEnv(name)`, `config[name]`).
4. Add `env/<channel>/<name>.env`, its `ENV_<NAME>` secret, and its env to the
   build step in `release.yml`.

## Known gaps

- **Signing.** macOS builds are ad-hoc signed and not notarized (the installer
  clears the quarantine flag; a DMG opened by hand needs right-click → Open).
  Windows builds are unsigned (SmartScreen warns). Add a Developer ID
  (`mac.identity`, `hardenedRuntime: true`, notarization) and a Windows
  certificate through CI secrets when available.
- **Schema upgrades.** A new release never touches `admin.db` and runs no
  migrations; a schema change needs a migration step in `main.js` first.
- **The apps' own integration.** The admin still calls core-api for flights;
  calling supplier-hub through `SUPPLIER_HUB_URL` and answering its
  `CORE_API_URL` callbacks is work in the admin repo. supplier-hub must also
  treat an empty `KAFKA_BROKERS` as "Kafka off" (its producer panics today).
