# Builds tap-meter in release mode and lays out a folder Plisto can install: plugin.json and the
# executable at the path the manifest names. Pass -Flags to write a tap-meter.flags file beside the
# executable, for example -Flags "--crash-after 2".
param(
    [string]$Out = (Join-Path $PSScriptRoot "dist\dev.plisto.tapmeter"),
    [string]$Flags = ""
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

    $manifest = Get-Content (Join-Path $PSScriptRoot "plugin.json") -Raw | ConvertFrom-Json
    $exe = Join-Path $Out ($manifest.entry -replace "/", "\")

    if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
    New-Item -ItemType Directory -Force (Split-Path $exe) | Out-Null
    Copy-Item (Join-Path $PSScriptRoot "plugin.json") $Out
    Copy-Item (Join-Path $PSScriptRoot "target\release\tap-meter.exe") $exe
    if ($Flags -ne "") {
        Set-Content -Path (Join-Path (Split-Path $exe) "tap-meter.flags") -Value $Flags -Encoding ascii
    }

    Write-Host "Packed $Out"
    Get-ChildItem $Out -Recurse -File | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($Out.Length + 1)) }
}
finally {
    Pop-Location
}
