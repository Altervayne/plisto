# Packs a UI sample into dist\<id>-<version>.plistoplugin beside its source: a zip of the files Plisto
# needs (plugin.json, the page, its scripts and styles, the icon, plisto-sdk.js), with no README and no
# dotfiles. Refuses when the sample's plisto-sdk.js differs from sdk\plisto-sdk.js. With no -Sample it packs
# hello-ui and hello-background. The native sample is packed by examples\tap-meter\pack.ps1.
param(
    [string[]]$Sample = @("hello-ui", "hello-background")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sdk = Join-Path $PSScriptRoot "..\sdk\plisto-sdk.js"
$sdkHash = (Get-FileHash $sdk -Algorithm SHA256).Hash

function Pack-Sample([string]$Name) {
    $src = Join-Path $PSScriptRoot $Name
    if (-not (Test-Path (Join-Path $src "plugin.json"))) { throw "$Name has no plugin.json" }

    $copy = Join-Path $src "plisto-sdk.js"
    if (-not (Test-Path $copy)) { throw "$Name has no plisto-sdk.js" }
    if ((Get-FileHash $copy -Algorithm SHA256).Hash -ne $sdkHash) {
        throw "$Name\plisto-sdk.js differs from sdk\plisto-sdk.js. Copy the kit's file over it and pack again."
    }

    $manifest = Get-Content (Join-Path $src "plugin.json") -Raw | ConvertFrom-Json
    $dist = Join-Path $src "dist"
    $zip = Join-Path $dist ("{0}-{1}.plistoplugin" -f $manifest.id, $manifest.version)
    New-Item -ItemType Directory -Force $dist | Out-Null
    if (Test-Path $zip) { Remove-Item $zip -Force }

    # Entry names use forward slashes, as Plisto reads them; dist and dotfiles stay out.
    $files = Get-ChildItem $src -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        $parts = $rel -split "[\\/]"
        ($parts[0] -ne "dist") -and ($rel -ne "README.md") -and -not ($parts | Where-Object { $_.StartsWith(".") })
    }
    $archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($f in $files) {
            $entry = ($f.FullName.Substring($src.Length + 1)) -replace "\\", "/"
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $f.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host "Packed $zip"
    $read = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $read.Entries | ForEach-Object { Write-Host ("  " + $_.FullName) }
    }
    finally {
        $read.Dispose()
    }
}

foreach ($name in $Sample) { Pack-Sample $name }
