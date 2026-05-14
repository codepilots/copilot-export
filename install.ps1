# install.ps1 — One-command installer for Copilot Chat Exporter.
#
# Usage (run in PowerShell as your normal user — no admin required):
#   irm 'https://YOUR_GITHUB_USERNAME.github.io/copilot-chat-exporter/install.ps1' | iex
#
# What this does:
#   1. Reads the extension ID and update URL from the hosted meta.json
#   2. Adds a single registry key so Edge auto-downloads and installs the extension
#   3. Restarts Edge (optional) — no developer mode required

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoBase = "https://YOUR_GITHUB_USERNAME.github.io/copilot-chat-exporter"

Write-Host ""
Write-Host "  Copilot Chat Exporter — Installer" -ForegroundColor Cyan
Write-Host "  ===================================" -ForegroundColor Cyan
Write-Host ""

# ── Fetch metadata from GitHub Pages ─────────────────────────────────────────
Write-Host "Fetching extension metadata..." -NoNewline
try {
    $meta = Invoke-RestMethod "$repoBase/meta.json" -UseBasicParsing
    $extId    = $meta.extensionId
    $updateUrl = $meta.updateUrl
    Write-Host " OK" -ForegroundColor Green
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host "  Could not reach $repoBase/meta.json" -ForegroundColor Red
    Write-Host "  Check your internet connection or visit the GitHub page for manual instructions."
    exit 1
}

Write-Host "  Extension ID : $extId"
Write-Host "  Update URL   : $updateUrl"
Write-Host ""

# ── Write registry key (HKCU — no admin needed) ───────────────────────────────
# Edge reads HKCU\...\ExtensionInstallForcelist and auto-downloads listed extensions.
# Value format: "<extension_id>;<update_manifest_url>"
$regPath = "HKCU:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist"

Write-Host "Writing registry key..." -NoNewline
try {
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    # Find the next available numbered value (1, 2, 3, ...)
    $existing = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    $existingValue = $existing.PSObject.Properties |
        Where-Object { $_.Value -like "$extId;*" } |
        Select-Object -First 1
    if ($existingValue) {
        Write-Host " already installed" -ForegroundColor Yellow
    } else {
        $nextIdx = 1
        while ($existing.PSObject.Properties.Name -contains "$nextIdx") { $nextIdx++ }
        Set-ItemProperty -Path $regPath -Name "$nextIdx" -Value "$extId;$updateUrl" -Type String
        Write-Host " OK" -ForegroundColor Green
    }
} catch {
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor Red
    exit 1
}

# ── Offer to restart Edge ─────────────────────────────────────────────────────
Write-Host ""
$edgeRunning = Get-Process -Name msedge -ErrorAction SilentlyContinue
if ($edgeRunning) {
    Write-Host "Edge is currently running." -ForegroundColor Yellow
    $ans = Read-Host "  Restart Edge now to apply the extension? [Y/n]"
    if ($ans -eq "" -or $ans -match "^[Yy]") {
        Write-Host "Closing Edge..." -NoNewline
        Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $edgePath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" -ErrorAction SilentlyContinue)."(Default)"
        if (-not $edgePath) {
            $edgePath = @(
                "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
            ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        }
        if ($edgePath) {
            Start-Process $edgePath
            Write-Host " restarted" -ForegroundColor Green
        } else {
            Write-Host " could not locate Edge — please restart it manually" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Open Microsoft Edge to complete installation." -ForegroundColor Cyan
    Write-Host "  The extension will download and install automatically on first launch."
}

Write-Host ""
Write-Host "Done! Copilot Chat Exporter is now queued for installation." -ForegroundColor Green
Write-Host "  Navigate to copilot.microsoft.com and click the extension icon to export a chat."
Write-Host ""
Write-Host "To uninstall, run:" -ForegroundColor Gray
Write-Host "  Remove-ItemProperty -Path '$regPath' -Name 1" -ForegroundColor Gray
Write-Host "  (and remove the extension from edge://extensions)" -ForegroundColor Gray
Write-Host ""
