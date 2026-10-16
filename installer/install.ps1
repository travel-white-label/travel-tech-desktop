# Installs White-Label Admin on Windows. It checks this computer (Windows
# version, CPU, disk, memory, an existing install), picks the matching build
# from this repo's GitHub releases, verifies its SHA-256 and runs the
# installer silently (per user, no admin rights). The data folder (database,
# secrets, logs) is never touched.
#
#   irm https://raw.githubusercontent.com/travel-white-label/white-label-desktop/main/installer/install.ps1 | iex
#   $env:CHANNEL = 'test';    irm … | iex     the latest test pre-release
#   $env:VERSION = 'v1.2.0';  irm … | iex     one specific release
#
# macOS and Linux: installer/install.sh.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with it
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

& {
  $Repo = if ($env:WL_REPO) { $env:WL_REPO } else { 'travel-white-label/white-label-desktop' }
  $Channel = if ($env:CHANNEL) { $env:CHANNEL } else { 'production' }
  switch ($Channel) {
    'production' { $Name = 'White-Label Admin'; $Prefix = 'white-label-admin-'; $Pkg = 'white-label-admin-desktop' }
    'test' { $Name = 'White-Label Admin Test'; $Prefix = 'white-label-admin-test-'; $Pkg = 'white-label-admin-desktop-test' }
    default { throw 'CHANNEL must be production or test' }
  }
  function Say($text) { Write-Host "  $text" }

  Write-Host 'Checking this computer'

  # --- Windows version and CPU ------------------------------------------------------
  if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows; on macOS or Linux run installer/install.sh' }
  $os = [Environment]::OSVersion.Version
  # ponytail: Electron's floor as of v44; raise it with the Electron version.
  if ($os.Major -lt 10) { throw "Windows $os is too old (Windows 10 or newer)" }
  $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($cpu) {
    'AMD64' { $arch = 'x64' }
    # There is no Windows ARM build; Windows 11 on ARM runs the x64 one emulated.
    'ARM64' { $arch = 'x64'; Write-Warning 'ARM64 CPU: installing the x64 build, which Windows runs emulated' }
    default { throw "Unsupported CPU $cpu (64-bit only)" }
  }
  Say "system: Windows $os, $cpu"

  # --- disk and memory ------------------------------------------------------------------
  $drive = (Get-Item $env:LOCALAPPDATA).PSDrive.Name
  $freeMb = [int]((Get-PSDrive $drive).Free / 1MB)
  if ($freeMb -lt 1500) { throw "Only $freeMb MB free on ${drive}: (1.5 GB needed)" }
  $memMb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  Say "disk: $freeMb MB free on ${drive}:, memory: $memMb MB"
  if ($memMb -lt 4000) { Write-Warning 'Less than 4 GB of memory: the app will run, but slowly' }

  # --- the release ------------------------------------------------------------------------
  $api = "https://api.github.com/repos/$Repo/releases"
  $release = if ($env:VERSION) {
    Invoke-RestMethod "$api/tags/$($env:VERSION)"
  } elseif ($Channel -eq 'production') {
    Invoke-RestMethod "$api/latest"
  } else {
    Invoke-RestMethod "${api}?per_page=30" | Where-Object { $_.prerelease -and $_.tag_name -like '*-test*' } | Select-Object -First 1
  }
  if (-not $release) { throw "No $Channel release in $Repo yet" }
  $file = "${Prefix}win-$arch.exe"
  $asset = $release.assets | Where-Object name -EQ $file
  $sums = $release.assets | Where-Object name -EQ 'checksums.txt'
  if (-not $asset) { throw "Release $($release.tag_name) has no $file" }
  if (-not $sums) { throw "Release $($release.tag_name) has no checksums.txt" }
  Say "release: $($release.tag_name) ($file)"

  # --- an existing install ------------------------------------------------------------------
  $installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object DisplayName -Match "^$([regex]::Escape($Name)) \d" | Select-Object -First 1
  if ($installed) { Say "upgrading $($installed.DisplayVersion)" }
  if (Get-Process -Name $Name -ErrorAction SilentlyContinue) { throw "$Name is running - quit it, then run this again" }

  # --- download and verify -------------------------------------------------------------------
  $tmp = Join-Path $env:TEMP ("white-label-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $path = Join-Path $tmp $file
    Write-Host "Downloading $file ($([int]($asset.size / 1MB)) MB)"
    Invoke-WebRequest $asset.browser_download_url -OutFile $path -UseBasicParsing
    $line = (Invoke-RestMethod $sums.browser_download_url) -split "`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($file))\s*$" }
    if (-not $line) { throw "checksums.txt has no entry for $file" }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "Checksum mismatch for $file - the download is damaged or was tampered with" }
    Say 'SHA-256 verified'

    # --- install ---------------------------------------------------------------------------
    Write-Host 'Installing'
    Unblock-File $path
    # NSIS: /S is silent; a per-user install goes to %LOCALAPPDATA%\Programs.
    $run = Start-Process $path -ArgumentList '/S' -Wait -PassThru
    if ($run.ExitCode -ne 0) { throw "The installer failed (exit code $($run.ExitCode))" }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host "$Name $($release.tag_name) is installed (Start menu: $Name)."
  Write-Host "Data folder (database, settings, logs): $(Join-Path $env:APPDATA $Pkg)"
}
