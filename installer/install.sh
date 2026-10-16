#!/usr/bin/env bash
# Installs White-Label Admin on macOS or Linux. It checks this computer (OS,
# CPU, OS version, disk, memory, an existing install), picks the matching
# build from this repo's GitHub releases, verifies its SHA-256 and installs it.
# The data folder (database, secrets, logs) is never touched.
#
#   curl -fsSL https://raw.githubusercontent.com/travel-white-label/white-label-desktop/main/installer/install.sh | bash
#   … | CHANNEL=test bash        the latest test pre-release
#   … | VERSION=v1.2.0 bash      one specific release
#   … | FORMAT=AppImage bash     Linux: AppImage even where a .deb would fit
#
# Windows: installer/install.ps1.
set -euo pipefail

REPO="${WL_REPO:-travel-white-label/white-label-desktop}"
CHANNEL="${CHANNEL:-production}"
VERSION="${VERSION:-}"
FORMAT="${FORMAT:-}"

say() { printf '  %s\n' "$*"; }
warn() { printf '  warning: %s\n' "$*" >&2; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
# version_ge A B: A >= B for dotted numbers
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

command -v curl >/dev/null || die "curl is required"
case "$CHANNEL" in
  production) NAME="White-Label Admin";      PREFIX="white-label-admin-";      PKG="white-label-admin-desktop" ;;
  test)       NAME="White-Label Admin Test"; PREFIX="white-label-admin-test-"; PKG="white-label-admin-desktop-test" ;;
  *) die "CHANNEL must be production or test" ;;
esac

echo "Checking this computer"

# --- OS and CPU -------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) die "unsupported OS $(uname -s) — on Windows run installer/install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m) (64-bit Intel/AMD or ARM only)" ;;
esac
# A terminal running under Rosetta reports x86_64 on Apple Silicon.
if [ "$os" = mac ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
say "system: $os $arch"

# --- OS version, package format ------------------------------------------------------
if [ "$os" = mac ]; then
  ver="$(sw_vers -productVersion)"
  # ponytail: Electron's floor as of v44; raise it with the Electron version.
  version_ge "$ver" 12 || die "macOS $ver is too old (12 Monterey or newer)"
  say "macOS $ver"
  ext=zip
else
  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  glibc="$(ldd --version 2>&1 | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
  say "${PRETTY_NAME:-Linux}, glibc ${glibc:-unknown}"
  if [ -n "$glibc" ]; then
    version_ge "$glibc" 2.28 || die "glibc $glibc is too old (2.28 or newer)"
    # The Linux builds are made on Ubuntu 22.04.
    version_ge "$glibc" 2.35 || warn "built against glibc 2.35; on $glibc some parts may not start"
  fi
  if [ -z "$FORMAT" ]; then
    if command -v dpkg >/dev/null && [[ " ${ID:-} ${ID_LIKE:-} " =~ [[:space:]](debian|ubuntu)[[:space:]] ]]; then
      FORMAT=deb
    else
      FORMAT=AppImage
    fi
  fi
  case "$FORMAT" in deb | AppImage) ext="$FORMAT" ;; *) die "FORMAT must be deb or AppImage" ;; esac
  say "package: $FORMAT"
fi

# --- disk and memory ------------------------------------------------------------------
free_kb="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
[ "$free_kb" -ge $((1500 * 1024)) ] || die "only $((free_kb / 1024)) MB free in $HOME (1.5 GB needed)"
if [ "$os" = mac ]; then mem=$(($(sysctl -n hw.memsize) / 1024 / 1024)); else mem=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024)); fi
say "disk: $((free_kb / 1024)) MB free, memory: $mem MB"
[ "$mem" -ge 4000 ] || warn "less than 4 GB of memory: the app will run, but slowly"

# --- the release ----------------------------------------------------------------------
api="https://api.github.com/repos/$REPO/releases"
if [ -n "$VERSION" ]; then
  release="$(curl -fsSL "$api/tags/$VERSION")" || die "release $VERSION not found in $REPO"
elif [ "$CHANNEL" = production ]; then
  release="$(curl -fsSL "$api/latest")" || die "no production release in $REPO yet"
else
  tag="$(curl -fsSL "$api?per_page=30" | grep -oE '"tag_name": *"[^"]*-test[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
  [ -n "$tag" ] || die "no test release in $REPO yet"
  release="$(curl -fsSL "$api/tags/$tag")"
fi
tag="$(printf '%s' "$release" | grep -oE '"tag_name": *"[^"]+"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
urls="$(printf '%s' "$release" | grep -oE '"browser_download_url": *"[^"]+"' | sed -E 's/.*"(https[^"]+)"$/\1/')"

# electron-builder names the Linux CPU per format (AppImage x86_64, deb amd64).
if [ "$arch" = x64 ]; then arch_re='x64|x86_64|amd64'; else arch_re='arm64|aarch64'; fi
url="$(printf '%s\n' "$urls" | grep -E "/${PREFIX}${os}-(${arch_re})\.${ext}$" | head -n1 || true)"
sums="$(printf '%s\n' "$urls" | grep -E '/checksums\.txt$' | head -n1 || true)"
[ -n "$url" ] || die "release $tag has no $os $arch .$ext build"
[ -n "$sums" ] || die "release $tag has no checksums.txt"
file="${url##*/}"
say "release: $tag ($file)"

# --- an existing install --------------------------------------------------------------
if [ "$os" = mac ]; then
  dest="/Applications"
  [ -w "$dest" ] || dest="$HOME/Applications"
  target="$dest/$NAME.app"
  if [ -d "$target" ]; then
    say "upgrading $(defaults read "$target/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "an existing install")"
  fi
  running="$NAME.app/Contents/MacOS/"
elif [ "$FORMAT" = deb ]; then
  current="$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null || true)"
  [ -z "$current" ] || say "upgrading $current"
  running="/opt/$NAME/"
else
  target="$HOME/Applications/$PKG.AppImage"
  [ ! -f "$target" ] || say "replacing $target"
  running="$target"
fi
if pgrep -f "$running" >/dev/null 2>&1; then die "$NAME is running — quit it, then run this again"; fi

# --- download and verify ----------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $file"
curl -fL --progress-bar -o "$tmp/$file" "$url"
expected="$(curl -fsSL "$sums" | awk -v f="$file" '$2 == f || $2 == "*"f {print $1}')"
[ -n "$expected" ] || die "checksums.txt has no entry for $file"
if command -v sha256sum >/dev/null; then actual="$(sha256sum "$tmp/$file" | awk '{print $1}')"; else actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"; fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $file — the download is damaged or was tampered with"
say "SHA-256 verified"

# --- install ----------------------------------------------------------------------------
echo "Installing"
if [ "$os" = mac ]; then
  mkdir -p "$dest"
  rm -rf "$target"
  ditto -xk "$tmp/$file" "$dest"
  # The build is ad-hoc signed, not notarized: lift the download quarantine.
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  data="$HOME/Library/Application Support/$PKG"
  say "installed $target"
elif [ "$FORMAT" = deb ]; then
  sudo=""; [ "$(id -u)" = 0 ] || sudo="sudo"
  if command -v apt-get >/dev/null; then $sudo apt-get install -y "$tmp/$file"; else $sudo dpkg -i "$tmp/$file"; fi
  data="${XDG_CONFIG_HOME:-$HOME/.config}/$PKG"
  say "installed $NAME (menu: Office)"
else
  mkdir -p "$HOME/Applications" "$HOME/.local/share/applications"
  install -m 755 "$tmp/$file" "$target"
  exec_line="\"$target\""
  if ! { ldconfig -p 2>/dev/null || true; } | grep -q 'libfuse.so.2'; then
    warn "libfuse2 is missing; the app will unpack itself on every start (install libfuse2 to avoid that)"
    exec_line="\"$target\" --appimage-extract-and-run"
  fi
  cat > "$HOME/.local/share/applications/$PKG.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Exec=$exec_line
Categories=Office;
Terminal=false
EOF
  data="${XDG_CONFIG_HOME:-$HOME/.config}/$PKG"
  say "installed $target"
fi

echo
echo "$NAME $tag is installed."
echo "Data folder (database, settings, logs): $data"
