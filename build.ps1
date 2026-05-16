# build.ps1 — Package the extension source into a distributable ZIP.
#
# This extension is distributed for manual installation only ("Load unpacked").
# There is no CRX, no signing key, and no auto-update channel: that removes the
# supply-chain risk of a self-hosted force-install / auto-update pipeline.
#
# Requires PowerShell 5+ (Windows) or PowerShell 7 (cross-platform).
#
# Usage:
#   .\build.ps1                       # -> copilot-chat-exporter.zip
#   .\build.ps1 -OutFile dist\ext.zip
#
# To install: unzip, open edge://extensions, enable Developer mode,
# click "Load unpacked" and select the unzipped folder.

param(
    [string]$OutFile = "copilot-chat-exporter.zip"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot

# Files/areas never shipped in the extension package.
$excludeNames = [System.Collections.Generic.HashSet[string]]@(
    'build.ps1', 'README.md', 'LICENSE', '.gitignore', 'generate-icons.js'
)

$outPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }
if (Test-Path $outPath) { Remove-Item $outPath -Force }

$outDir = Split-Path $outPath -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir | Out-Null }

$zipMs = [System.IO.MemoryStream]::new()
$zip   = [System.IO.Compression.ZipArchive]::new($zipMs, [System.IO.Compression.ZipArchiveMode]::Create, $true)
$count = 0

Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/')
    -not ($rel -match '^\.git[/\\]' -or
          $rel -match '^docs[/\\]'  -or
          $excludeNames.Contains($_.Name) -or
          $_.Extension -in '.pem', '.crx', '.zip', '.xpi')
} | ForEach-Object {
    $entryName = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $fs = [System.IO.File]::OpenRead($_.FullName)
    $fs.CopyTo($es)
    $fs.Dispose()
    $es.Dispose()
    $count++
}

$zip.Dispose()
[System.IO.File]::WriteAllBytes($outPath, $zipMs.ToArray())
$zipMs.Dispose()

Write-Host ""
Write-Host "Packaged $count files -> $outPath" -ForegroundColor Green
Write-Host ""
Write-Host "Install:" -ForegroundColor Yellow
Write-Host "  1. Unzip $([System.IO.Path]::GetFileName($outPath))"
Write-Host "  2. Open edge://extensions (or chrome://extensions)"
Write-Host "  3. Enable Developer mode"
Write-Host "  4. Click 'Load unpacked' and select the unzipped folder"
Write-Host ""
