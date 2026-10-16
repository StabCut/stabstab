#Requires -Version 5.1
<#
.SYNOPSIS
  Preflight cleanup of the release\ staging directories used by the Windows packaging step.

.DESCRIPTION
  ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 files as ANSI (GBK
  on zh-CN), so non-ASCII characters here would corrupt the script. Chinese notes belong
  in the docs, same as android-build.ps1.

  electron-builder stages the unpacked app in release\<target>.tmp and deletes that whole
  directory at the start of every run. On Windows one single file left open by ANY other
  process makes that unlink fail, and the build dies with a message that names neither the
  file's owner nor the cause:

      EBUSY: resource busy or locked, unlink
        '...\release\win-unpacked.tmp\resources\default_app.asar'

  That is exactly what happened on 2026-10-16: Typora had C:\Users\Administrator\Documents
  mounted as a sidebar folder, the project lives inside Documents, and Typora's RENDERER
  process leaked a read handle on the freshly staged default_app.asar. The next run then
  died while cleaning up the PREVIOUS run's leftover and never reached the packaging step --
  which is why the failure looked like "electron-builder is broken" rather than "a file is
  still open".

  This script removes the staging dirs BEFORE electron-builder runs and, when a file is
  still held open, names the exact holding pid and process through the Windows Restart
  Manager (see lib\RmFileLock.cs), the same API the shell's "file is in use" dialog uses.

  Exit codes: 0 = staging dirs are gone (or were never there), safe to package;
              1 = something still holds a file, the caller must NOT start packaging.

.PARAMETER ReleaseDir
  The release\ directory to clean. Defaults to <repo root>\release.

.PARAMETER Target
  Staging/target directory names to remove. Defaults to win-unpacked.tmp and win-unpacked,
  the two directories the Windows nsis/portable targets use.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-release.ps1

.EXAMPLE
  scripts\package.cmd
  # package.cmd runs this script and aborts with guidance when it exits 1.
#>
[CmdletBinding()]
param(
    [string]$ReleaseDir,
    [string[]]$Target = @('win-unpacked.tmp', 'win-unpacked')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptDir
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $repoRoot 'release' }
$lockLib = Join-Path $scriptDir 'lib\RmFileLock.cs'

# The pid enumeration below must not die on a single inaccessible file, so file probes run
# with a non-terminating preference and are filtered by hand.
function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=== ' + $Text) -ForegroundColor Cyan
}

function Get-HolderLabel {
    param([int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return ('PID ' + $ProcessId + '  (process has already exited)') }
    $label = 'PID ' + $ProcessId + '  ' + $proc.ProcessName
    $started = $null
    try { $started = $proc.StartTime } catch { }
    if ($started) { $label += '  (started ' + $started.ToString('yyyy-MM-dd HH:mm:ss') + ')' }
    return $label
}

if (-not ('RmFileLock' -as [type])) {
    if (-not (Test-Path -LiteralPath $lockLib)) {
        Write-Host ('[clean-release] missing helper ' + $lockLib) -ForegroundColor Red
        exit 1
    }
    # -Path with a dedicated .cs file. Passing the same source through an Add-Type
    # -TypeDefinition here-string fails in this environment with CS1040, while -Path
    # compiles it cleanly, so the C# deliberately lives in its own file.
    Add-Type -Path $lockLib
}

$holders = New-Object System.Collections.Generic.List[object]
$unexplained = New-Object System.Collections.Generic.List[string]

Write-Step ('Cleaning release staging directories in ' + $ReleaseDir)

foreach ($name in $Target) {
    $path = Join-Path $ReleaseDir $name
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host ('    ' + $name + ' - not present, nothing to clean')
        continue
    }

    try {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        Write-Host ('    ' + $name + ' - removed') -ForegroundColor Green
        continue
    }
    catch {
        Write-Host ('    ' + $name + ' - LOCKED, inspecting why') -ForegroundColor Yellow
    }

    # The delete failed: find which remaining file is held open, and by whom.
    $remaining = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 400) { $remaining = $remaining[0..399] }

    $foundForThisTarget = $false
    foreach ($file in $remaining) {
        $probe = $null
        $probe = @([RmFileLock]::Who($file.FullName))
        foreach ($entry in $probe) {
            $parts = @($entry.Split('|'))
            $holderPid = 0
            if (-not [int]::TryParse($parts[0], [ref]$holderPid)) { continue }
            $service = $null
            if ($parts.Count -ge 3 -and $parts[2]) { $service = $parts[2] }
            $holders.Add([pscustomobject]@{
                Target  = $name
                File    = $file.FullName
                AppName = $parts[1]
                Service = $service
                Label   = (Get-HolderLabel -ProcessId $holderPid)
            })
            $foundForThisTarget = $true
        }
        if ($holders.Count -ge 10) { break }
    }

    if (-not $foundForThisTarget) {
        # No file-level holder was reported: the directory itself is in use (a process may
        # have it as its current working directory), or a filter driver is holding it without
        # exposing a handle we can attribute. Report it instead of pretending it is clean.
        $left = @(Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue).Count
        $unexplained.Add($name + ' (' + $left + ' entries still present)')
    }
}

if ($holders.Count -eq 0 -and $unexplained.Count -eq 0) {
    Write-Host ''
    Write-Host '[clean-release] OK - release staging directories are clean.' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host '[clean-release] FAILED: release staging directories could not be cleaned.' -ForegroundColor Red
Write-Host ''

foreach ($h in $holders) {
    Write-Host ('  [' + $h.Target + '] ' + $h.Label) -ForegroundColor Yellow
    Write-Host ('      holds: ' + $h.File)
    if ($h.Service) { Write-Host ('      service: ' + $h.Service) }
}

foreach ($u in $unexplained) {
    Write-Host ('  [' + $u + '] no single file reported as held - the directory itself is in' +
                ' use, or a filter driver holds it without a queryable handle') -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  Packaging would fail with: EBUSY: resource busy or locked, unlink ...'
Write-Host '  Close the process listed above (or stop the listed service), then package again.'
Write-Host '  Usual suspects on this machine:'
Write-Host '    - an editor with the project folder mounted (Typora had Documents mounted)'
Write-Host '    - a StabStab.exe still running out of release\win-unpacked'
Write-Host '    - a sync client (zBox / OneDrive) or an EDR / document-encryption agent'
Write-Host ''
exit 1
