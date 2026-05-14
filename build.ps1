# build.ps1 — Pack the extension and generate GitHub Pages release artefacts.
# Run this from the repo root before tagging a release.
#
# Prerequisites: Microsoft Edge must be installed.
# Run once to generate edge-copilot.pem (keep it safe — do NOT commit it).
# On every subsequent build, the same .pem is reused so the extension ID stays stable.

param(
    [string]$Version = "1.0.0",
    [string]$GitHubUser = "",   # e.g. "octocat"
    [string]$GitHubRepo = "copilot-chat-exporter"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Locate Edge ───────────────────────────────────────────────────────────────
$edgePaths = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found. Install Edge and re-run." }

$root    = $PSScriptRoot
$docsDir = Join-Path $root "docs"
$pemFile = Join-Path $root "edge-copilot.pem"
$crxSrc  = Join-Path $root "edge-copilot.crx"
$crxDst  = Join-Path $docsDir "extension.crx"

if (-not (Test-Path $docsDir)) { New-Item -ItemType Directory $docsDir | Out-Null }

# ── Pack the extension ────────────────────────────────────────────────────────
Write-Host "Packing extension with Edge..." -ForegroundColor Cyan

$packArgs = @("--pack-extension=`"$root`"")
if (Test-Path $pemFile) { $packArgs += "--pack-extension-key=`"$pemFile`"" }

$proc = Start-Process -FilePath $edge -ArgumentList $packArgs -PassThru -Wait -WindowStyle Hidden
Start-Sleep -Seconds 3   # Edge writes files asynchronously

if (-not (Test-Path $crxSrc)) {
    throw "Packing failed — edge-copilot.crx was not created. Check Edge output."
}

Write-Host "  .crx created: $crxSrc"
if (Test-Path $pemFile) { Write-Host "  .pem (keep safe, do NOT commit): $pemFile" }

# ── Derive extension ID from the .crx public key ─────────────────────────────
# CRX3 layout: magic(4) + version(4) + header_size(4) + proto_header + zip_data
# The proto header contains the signed_header_data which holds the public key.
# Simpler: unzip the .crx (strip the CRX header) and hash the zip; Edge stores
# the extension ID based on the SHA-256 of the SubjectPublicKeyInfo DER bytes.
# We derive it here by parsing the packed .crx binary.

function Get-ExtensionId([string]$crxPath) {
    $bytes = [System.IO.File]::ReadAllBytes($crxPath)
    # CRX3: magic "Cr24" = 0x43 0x72 0x32 0x34
    if ($bytes[0] -ne 0x43 -or $bytes[1] -ne 0x72 -or $bytes[2] -ne 0x32 -or $bytes[3] -ne 0x34) {
        throw "Not a valid CRX3 file"
    }
    # Bytes 8..11 = header_size (little-endian)
    $headerSize = [BitConverter]::ToUInt32($bytes, 8)
    # Proto-encoded CrxFileHeader starts at offset 12; length = headerSize
    $protoBytes = $bytes[12..(12 + $headerSize - 1)]

    # Parse protobuf to find sha256_with_rsa field (field 2, wire type 2 = LEN)
    # and extract the public_key bytes from AsymmetricKeyProof (field 1).
    # Field tag encoding: (field_number << 3) | wire_type
    # sha256_with_rsa = field 2 => tag = (2<<3)|2 = 0x12
    $pubKeyDer = $null
    $i = 0
    while ($i -lt $protoBytes.Length) {
        $tag = $protoBytes[$i]; $i++
        $fieldNum = $tag -shr 3
        $wireType = $tag -band 0x07
        if ($wireType -eq 2) {
            # Read varint length
            $len = 0; $shift = 0
            while ($true) {
                $b = $protoBytes[$i]; $i++
                $len = $len -bor (($b -band 0x7F) -shl $shift); $shift += 7
                if (-not ($b -band 0x80)) { break }
            }
            $fieldBytes = $protoBytes[$i..($i + $len - 1)]; $i += $len
            if ($fieldNum -eq 2 -and $pubKeyDer -eq $null) {
                # This is an AsymmetricKeyProof — field 1 inside it is public_key
                $j = 0
                while ($j -lt $fieldBytes.Length) {
                    $innerTag = $fieldBytes[$j]; $j++
                    $innerField = $innerTag -shr 3; $innerWire = $innerTag -band 7
                    if ($innerWire -eq 2) {
                        $ilen = 0; $ishift = 0
                        while ($true) {
                            $ib = $fieldBytes[$j]; $j++
                            $ilen = $ilen -bor (($ib -band 0x7F) -shl $ishift); $ishift += 7
                            if (-not ($ib -band 0x80)) { break }
                        }
                        $innerData = $fieldBytes[$j..($j + $ilen - 1)]; $j += $ilen
                        if ($innerField -eq 1) { $pubKeyDer = $innerData; break }
                    } else { break }
                }
            }
        } elseif ($wireType -eq 0) {
            while ($protoBytes[$i] -band 0x80) { $i++ }; $i++
        } else { break }
        if ($pubKeyDer) { break }
    }

    if (-not $pubKeyDer) { throw "Could not extract public key from .crx" }

    $hash   = [System.Security.Cryptography.SHA256]::Create().ComputeHash([byte[]]$pubKeyDer)
    $id     = -join ($hash[0..15] | ForEach-Object {
        [char]([int][char]'a' + ($_ -band 0x0F))
        [char]([int][char]'a' + (($_ -shr 4) -band 0x0F))
    })
    return $id
}

try {
    $extId = Get-ExtensionId $crxSrc
    Write-Host "  Extension ID: $extId" -ForegroundColor Green
} catch {
    Write-Warning "Could not derive extension ID automatically: $_"
    $extId = Read-Host "Paste the extension ID (visible in edge://extensions after loading unpacked)"
}

# ── Copy .crx to docs/ ────────────────────────────────────────────────────────
Copy-Item $crxSrc $crxDst -Force
Write-Host "  Copied to: $crxDst"

# ── Build update.xml ──────────────────────────────────────────────────────────
$baseUrl = if ($GitHubUser) {
    "https://$GitHubUser.github.io/$GitHubRepo"
} else {
    "https://YOUR_GITHUB_USERNAME.github.io/$GitHubRepo"
}

$updateXml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$extId'>
    <updatecheck codebase='$baseUrl/extension.crx' version='$Version'/>
  </app>
</gupdate>
"@
$updateXml | Out-File -FilePath (Join-Path $docsDir "update.xml") -Encoding utf8
Write-Host "  docs/update.xml written"

# ── Build meta.json (read by install.ps1) ────────────────────────────────────
$metaJson = @"
{
  "extensionId": "$extId",
  "version": "$Version",
  "updateUrl": "$baseUrl/update.xml"
}
"@
$metaJson | Out-File -FilePath (Join-Path $docsDir "meta.json") -Encoding utf8
Write-Host "  docs/meta.json written"

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Commit the docs/ folder (NOT edge-copilot.pem)"
Write-Host "  2. Push to GitHub and enable Pages on the docs/ folder"
if ($GitHubUser) {
    Write-Host "  3. Landing page: $baseUrl"
    Write-Host "  4. Share the install command:"
    Write-Host "     irm '$baseUrl/install.ps1' | iex" -ForegroundColor Cyan
} else {
    Write-Host "  3. Re-run with -GitHubUser yourname to embed your URLs"
}
