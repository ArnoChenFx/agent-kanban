# agent-kanban one-line installer (Windows / PowerShell)
#
#   irm https://raw.githubusercontent.com/ArnoChenFx/agent-kanban/main/install/install.ps1 | iex
#
# Installs to a per-user directory (no administrator rights required) and adds that
# directory to the **user-level** PATH only.

$ErrorActionPreference = 'Stop'

$RepoSlug = 'ArnoChenFx/agent-kanban'
$DockerImage = 'ghcr.io/arnochenfx/agent-kanban:latest'
$BinName = 'agent-kanban'
# Only x64 binaries are published. The Docker image is multi-architecture.
$Asset = 'agent-kanban-windows-x64.exe'

function Get-DownloadBase {
    # AGENT_KANBAN_DOWNLOAD_BASE / AGENT_KANBAN_VERSION / AGENT_KANBAN_INSTALL_DIR make
    # this script testable: scripts/verify-install.ts points the download at a local
    # fake server, so the gate runs without network access.
    if ($env:AGENT_KANBAN_DOWNLOAD_BASE) {
        return $env:AGENT_KANBAN_DOWNLOAD_BASE.TrimEnd('/')
    }
    if ($env:AGENT_KANBAN_VERSION) {
        return "https://github.com/$RepoSlug/releases/download/v$($env:AGENT_KANBAN_VERSION)"
    }
    # /releases/latest/download resolves to the newest non-prerelease release.
    return "https://github.com/$RepoSlug/releases/latest/download"
}

function Get-InstallDir {
    if ($env:AGENT_KANBAN_INSTALL_DIR) { return $env:AGENT_KANBAN_INSTALL_DIR }
    return (Join-Path $env:LOCALAPPDATA 'Programs\agent-kanban')
}

function Install-AgentKanban {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLower()
    if ($arch -ne 'x64') {
        throw "no Windows $arch binary is published (only windows-x64).`n" +
              "The Docker image is multi-architecture and resolves this for you:`n" +
              "  docker run -d --name agent-kanban -p 7788:7788 -v kanban-data:/data $DockerImage"
    }

    $base = Get-DownloadBase
    $url = "$base/$Asset"
    $installDir = Get-InstallDir
    $target = Join-Path $installDir "$BinName.exe"

    Write-Host 'agent-kanban installer'
    Write-Host "  platform    Windows/$arch"
    Write-Host "  asset       $Asset"
    Write-Host "  install to  $target"
    Write-Host ''

    # Download to a temp file first, then move into place. A partial download must
    # never land on the final name, and Move-Item onto an existing file is what makes
    # re-running this script an in-place upgrade.
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-kanban-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
        $tmpBin = Join-Path $tmpDir $Asset
        Write-Host "Downloading $url"
        # -UseBasicParsing avoids the IE engine on Windows PowerShell 5.1; the real
        # reason we do not pipe a download into iex is that this file is already the
        # thing being executed from the network.
        Invoke-WebRequest -Uri $url -OutFile $tmpBin -UseBasicParsing

        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        # A running executable cannot be overwritten on Windows, so a leftover
        # agent-kanban.exe would make the upgrade fail. Replacing the directory entry
        # is a rename, which the filesystem allows.
        Copy-Item -Path $tmpBin -Destination $target -Force
    }
    finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Add-ToUserPath $installDir

    Write-Host ''
    # Actually run it: a 404 page saved as an .exe, a truncated download, or the
    # wrong architecture only shows up at execution time.
    & $target --version

    Write-Host ''
    Write-Host "Installed to $target"
    Write-Host ''
    Write-Host 'Next:'
    Write-Host '  agent-kanban init                  create a board in the current directory'
    Write-Host '  agent-kanban serve                 web board on http://127.0.0.1:7788/'
    Write-Host '  agent-kanban install-protocol      teach your agents to use the board'
    Write-Host ''
    Write-Host 'Upgrade later by re-running this script.'
    Write-Host "Uninstall by deleting $target and the PATH entry."
}

function Add-ToUserPath {
    param([string]$Dir)

    # AGENT_KANBAN_SKIP_PATH=1 lets scripts/verify-install.ts run this script with a
    # throwaway install dir; otherwise the gate would append a real PATH entry
    # pointing at a directory that no longer exists after the test finishes.
    if ($env:AGENT_KANBAN_SKIP_PATH -eq '1') {
        Write-Host 'Skipping the PATH update (AGENT_KANBAN_SKIP_PATH=1).'
        return
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }
    # Compare case-insensitively: Windows paths are case-insensitive, and a
    # near-duplicate entry is exactly what this check exists to prevent.
    $entries = $userPath.Split(';') | Where-Object { $_ -ne '' }
    if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }) {
        Write-Host "$Dir is already on your user PATH."
        return
    }

    $newPath = if ($userPath.TrimEnd(';') -eq '') { $Dir } else { "$userPath;$Dir" }
    # User scope only. Writing the machine PATH needs an elevated shell, and a
    # non-admin terminal would fail outright. Consequence: a process that was
    # started with a PATH inherited from before the install (e.g. Explorer-launched
    # apps) will not see the new command until it is restarted.
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $Dir to your user PATH."
    Write-Host 'Open a new terminal to pick it up.'
}

try {
    Install-AgentKanban
}
catch {
    # Deliberately not `exit`: this script is normally piped into iex, where
    # `exit` would close the user's whole terminal window instead of just this
    # script. Report and hand the session back.
    Write-Host ''
    Write-Error "agent-kanban install failed: $($_.Exception.Message)"
}
