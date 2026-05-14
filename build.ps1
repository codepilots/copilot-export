# build.ps1 - Pack the extension and generate GitHub Pages release artefacts.
# Run this from the repo root before tagging a release.
#
# Requires PowerShell 7+ (uses .NET 6 crypto APIs).
# Install PowerShell 7: winget install Microsoft.PowerShell
#
# Usage:
#   .\build.ps1 -GitHubUser codepilots -GitHubRepo copilot-export
#
# The private key is saved to edge-copilot.pem (gitignored).
# Keep it safe - you need it to publish updates with the same extension ID.

param(
    [string]$Version    = "1.0.0",
    [string]$GitHubUser = "",
    [string]$GitHubRepo = "copilot-chat-exporter"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Host ""
    Write-Host "PowerShell 7 is required (you have $($PSVersionTable.PSVersion))." -ForegroundColor Red
    Write-Host "Install it with:  winget install Microsoft.PowerShell" -ForegroundColor Yellow
    Write-Host "Then re-run this script in a new PowerShell 7 terminal." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root    = $PSScriptRoot
$docsDir = Join-Path $root "docs"
$pemFile = Join-Path $root "edge-copilot.pem"
$crxDst  = Join-Path $docsDir "extension.crx"

if (-not (Test-Path $docsDir)) { New-Item -ItemType Directory $docsDir | Out-Null }

# ── Helpers: byte array concatenation ────────────────────────────────────────

function Join-Bytes {
    $ms = [System.IO.MemoryStream]::new()
    function Append($x) {
        if ($null -eq $x) { return }
        if ($x -is [byte[]]) {
            if ($x.Length -gt 0) { $ms.Write($x, 0, $x.Length) }
        } elseif ($x -is [System.Collections.IEnumerable]) {
            foreach ($child in $x) { Append $child }
        } else {
            $ms.WriteByte([byte]$x)
        }
    }
    foreach ($item in $args) { Append $item }
    return ,$ms.ToArray()
}

# ── Helpers: protobuf encoding ────────────────────────────────────────────────

function Write-Varint([int64]$v) {
    $out = [System.Collections.Generic.List[byte]]::new()
    do {
        $b = [byte]($v -band 0x7F)
        $v = $v -shr 7
        if ($v -gt 0) { $b = $b -bor 0x80 }
        $out.Add($b)
    } while ($v -gt 0)
    return ,$out.ToArray()
}

function Write-ProtoField([int]$field, [byte[]]$data) {
    $tag = [int64](($field -shl 3) -bor 2)   # wire type 2 = length-delimited
    return Join-Bytes (Write-Varint $tag) (Write-Varint $data.Length) $data
}

# ── Load or generate RSA key ──────────────────────────────────────────────────

$rsa = [System.Security.Cryptography.RSA]::Create(2048)

if (Test-Path $pemFile) {
    $pem = [System.IO.File]::ReadAllText($pemFile)
    $rsa.ImportFromPem($pem)
    Write-Host "Loaded existing key from edge-copilot.pem"
} else {
    $privDer = $rsa.ExportPkcs8PrivateKey()
    $pem = "-----BEGIN PRIVATE KEY-----`n" +
           [Convert]::ToBase64String($privDer, [Base64FormattingOptions]::InsertLineBreaks) +
           "`n-----END PRIVATE KEY-----"
    [System.IO.File]::WriteAllText($pemFile, $pem, [System.Text.Encoding]::ASCII)
    Write-Host "Generated new private key -> edge-copilot.pem  (keep safe, do NOT commit)"
}

# ── Derive extension ID ───────────────────────────────────────────────────────

$pubKeyDer = $rsa.ExportSubjectPublicKeyInfo()
$sha256    = [System.Security.Cryptography.SHA256]::Create()
$keyHash   = $sha256.ComputeHash($pubKeyDer)
$crxId     = [byte[]]$keyHash[0..15]    # first 16 bytes

# Each byte -> two letters (low nibble first, then high nibble), using a-p
$extId = -join ($crxId | ForEach-Object {
    [char]([int][char]'a' + ($_ -band 0x0F))
    [char]([int][char]'a' + (($_ -shr 4) -band 0x0F))
})

Write-Host "Extension ID: $extId" -ForegroundColor Green

# ── Create ZIP of extension files ─────────────────────────────────────────────

$zipMs = [System.IO.MemoryStream]::new()
$zip   = [System.IO.Compression.ZipArchive]::new($zipMs, [System.IO.Compression.ZipArchiveMode]::Create, $true)
$script:entryCount = 0

$excludeNames = [System.Collections.Generic.HashSet[string]]@(
    'build.ps1','install.ps1','README.md','LICENSE','.gitignore','edge-copilot.pem'
)

Get-ChildItem -Path $root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\','/')
    -not ($rel -match '^\.git[/\\]' -or
          $rel -match '^docs[/\\]'  -or
          $excludeNames.Contains($_.Name) -or
          $_.Extension -in '.pem','.crx','.zip','.xpi')
} | ForEach-Object {
    $entryName = $_.FullName.Substring($root.Length).TrimStart('\','/').Replace('\','/')
    $entry  = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $es     = $entry.Open()
    $fs     = [System.IO.File]::OpenRead($_.FullName)
    $fs.CopyTo($es)
    $fs.Dispose()
    $es.Dispose()
    $script:entryCount++
}

$entryCount = $script:entryCount
$zip.Dispose()
$zipBytes = $zipMs.ToArray()
$zipMs.Dispose()

Write-Host "ZIP created ($([Math]::Round($zipBytes.Length/1KB, 1)) KB, $entryCount entries)"

# ── Build CRX3 ────────────────────────────────────────────────────────────────
#
# CRX3 format:
#   magic(4) + version_uint32le(4) + header_size_uint32le(4) + protobuf_header + zip
#
# CrxFileHeader protobuf:
#   field 2  (sha256_with_rsa) -> AsymmetricKeyProof { field1: pubkey, field2: sig }
#   field 10000 (signed_header_data) -> SignedData { field1: crx_id (16 bytes) }
#
# Signature covers:
#   b"CRX3 SignedData\0" + uint32le(len(signed_data)) + signed_data

# SignedData protobuf (field 1 = crx_id)
$signedData = Write-ProtoField 1 $crxId

# Signing input
$prefix   = [System.Text.Encoding]::ASCII.GetBytes("CRX3 SignedData`0")
$sdLenLE  = [BitConverter]::GetBytes([uint32]$signedData.Length)
$sigInput = Join-Bytes $prefix $sdLenLE $signedData

$signature = $rsa.SignData(
    [byte[]]$sigInput,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

# AsymmetricKeyProof { public_key, signature }
$keyProof = Join-Bytes (Write-ProtoField 1 $pubKeyDer) (Write-ProtoField 2 $signature)

# CrxFileHeader { sha256_with_rsa(2), signed_header_data(10000) }
$crxHeader = Join-Bytes (Write-ProtoField 2 $keyProof) (Write-ProtoField 10000 $signedData)

# Full CRX3 binary
$crxBytes = Join-Bytes `
    ([byte[]](0x43,0x72,0x32,0x34)) `
    ([BitConverter]::GetBytes([uint32]3)) `
    ([BitConverter]::GetBytes([uint32]$crxHeader.Length)) `
    $crxHeader `
    $zipBytes

[System.IO.File]::WriteAllBytes($crxDst, $crxBytes)
Write-Host "CRX3 written -> docs/extension.crx ($([Math]::Round($crxBytes.Length/1KB,1)) KB)"

# ── Write update.xml ──────────────────────────────────────────────────────────

$baseUrl = if ($GitHubUser) {
    "https://$GitHubUser.github.io/$GitHubRepo"
} else {
    "https://YOUR_GITHUB_USERNAME.github.io/$GitHubRepo"
}

@"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$extId'>
    <updatecheck codebase='$baseUrl/extension.crx' version='$Version'/>
  </app>
</gupdate>
"@ | Out-File (Join-Path $docsDir "update.xml") -Encoding utf8NoBOM

# ── Write meta.json ───────────────────────────────────────────────────────────

@"
{
  "extensionId": "$extId",
  "version": "$Version",
  "updateUrl": "$baseUrl/update.xml"
}
"@ | Out-File (Join-Path $docsDir "meta.json") -Encoding utf8NoBOM

# ── Update install.ps1 with the real base URL ─────────────────────────────────

if ($GitHubUser) {
    $installPath = Join-Path $root "install.ps1"
    $content = [System.IO.File]::ReadAllText($installPath)
    $updated = $content -replace 'https://YOUR_GITHUB_USERNAME\.github\.io/[^"]+', "$baseUrl"
    if ($updated -ne $content) {
        [System.IO.File]::WriteAllText($installPath, $updated, [System.Text.Encoding]::UTF8)
        Write-Host "install.ps1 updated with $baseUrl"
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Extension ID : $extId"
Write-Host "Base URL     : $baseUrl"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. git add docs/ install.ps1 && git commit -m 'Release v$Version' && git push"
Write-Host "  2. Enable GitHub Pages on the docs/ folder in repo Settings -> Pages"
Write-Host "  3. Share the install command:"
Write-Host "       irm '$baseUrl/install.ps1' | iex" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Keep edge-copilot.pem safe - it's needed to publish future updates" -ForegroundColor DarkYellow
