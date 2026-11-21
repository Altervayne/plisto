# Packs a plugin into an installable <id>-<version>.plistoplugin: a zip with plugin.json at its root.
#
#   -Sample <name>[,<name>]  A sample folder under examples\ (default: hello-ui and hello-background). The
#                            file goes to dist\ inside the sample. A sample is packed without its README.md
#                            and its dist folder, and its plisto-sdk.js must match sdk\plisto-sdk.js.
#   -Path <folder>           Any plugin folder, such as your own. The file goes to the folder's parent
#                            folder, or to -Out. Every file in the folder is packed except dotfiles, dot
#                            folders and .plistoplugin files, so stage a native plugin first (see
#                            tap-meter\pack.ps1).
#   -Out <folder>            Where the file goes, for both forms.
#
# Entry names are written with forward slashes, as Plisto reads them. Compress-Archive in Windows
# PowerShell 5.1 can write backslashes, which Plisto refuses, so the archive is built here entry by entry.
param(
    [string[]]$Sample = @("hello-ui", "hello-background"),
    [string]$Path = "",
    [string]$Out = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sdk = Join-Path $PSScriptRoot "..\sdk\plisto-sdk.js"
$sdkHash = (Get-FileHash $sdk -Algorithm SHA256).Hash

# Reads and checks plugin.json and the files it names. Returns the parsed manifest.
function Read-Manifest([string]$Src) {
    $file = Join-Path $Src "plugin.json"
    if (-not (Test-Path $file -PathType Leaf)) { throw "$Src has no plugin.json at its root" }
    $manifest = Get-Content $file -Raw | ConvertFrom-Json
    # A plugin that only adds visualizers has no page of its own, so it needs no entry.
    $needed = @("id", "version")
    if (-not $manifest.visualizers) { $needed += "entry" }
    foreach ($field in $needed) {
        if (-not $manifest.$field) { throw "plugin.json has no '$field'" }
    }
    foreach ($field in @("name", "author")) {
        $value = [string]$manifest.$field
        if ($value -ne $value.Trim()) { throw "'$field' must not start or end with a space" }
    }
    $kindFiles = @($manifest.visualizers) | ForEach-Object { if ($_) { $_.page; $_.shader } }
    $named = @($manifest.entry, $manifest.page, $manifest.icon) + @($kindFiles) | Where-Object { $_ }
    foreach ($rel in $named) {
        if (-not (Test-Path (Join-Path $Src ($rel -replace "/", "\")) -PathType Leaf)) {
            throw "plugin.json names '$rel', which is not in $Src"
        }
    }
    return $manifest
}

# Writes the files as a zip with forward-slash entry names, then lists the entries.
function Write-Archive([string]$Src, [object[]]$Files, [string]$Zip) {
    if (Test-Path $Zip) { Remove-Item $Zip -Force }
    $archive = [System.IO.Compression.ZipFile]::Open($Zip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($f in $Files) {
            $entry = ($f.FullName.Substring($Src.Length + 1)) -replace "\\", "/"
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $f.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host "Packed $Zip"
    $read = [System.IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $read.Entries | ForEach-Object { Write-Host ("  " + $_.FullName) }
    }
    finally {
        $read.Dispose()
    }
}

function Has-Dotname([string]$Rel) {
    return [bool](($Rel -split "[\\/]") | Where-Object { $_.StartsWith(".") })
}

function Pack-Sample([string]$Name, [string]$Dest) {
    $src = (Resolve-Path (Join-Path $PSScriptRoot $Name)).Path
    $manifest = Read-Manifest $src

    $copy = Join-Path $src "plisto-sdk.js"
    if (-not (Test-Path $copy)) { throw "$Name has no plisto-sdk.js" }
    if ((Get-FileHash $copy -Algorithm SHA256).Hash -ne $sdkHash) {
        throw "$Name\plisto-sdk.js differs from sdk\plisto-sdk.js. Copy the kit's file over it and pack again."
    }

    if (-not $Dest) { $Dest = Join-Path $src "dist" }
    New-Item -ItemType Directory -Force $Dest | Out-Null
    $zip = Join-Path (Resolve-Path $Dest).Path ("{0}-{1}.plistoplugin" -f $manifest.id, $manifest.version)

    # The sample's dist folder and README stay out, with dotfiles.
    $files = Get-ChildItem $src -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($src.Length + 1)
        ($rel -split "[\\/]")[0] -ne "dist" -and $rel -ne "README.md" -and -not (Has-Dotname $rel)
    }
    Write-Archive $src $files $zip
}

function Pack-Folder([string]$Folder, [string]$Dest) {
    if (-not (Test-Path $Folder -PathType Container)) { throw "$Folder is not a folder" }
    $src = (Resolve-Path $Folder).Path.TrimEnd("\")
    $manifest = Read-Manifest $src

    $copy = Join-Path $src "plisto-sdk.js"
    if ((Test-Path $copy) -and (Get-FileHash $copy -Algorithm SHA256).Hash -ne $sdkHash) {
        Write-Warning "plisto-sdk.js in $src differs from the kit's sdk\plisto-sdk.js."
    }

    if (-not $Dest) { $Dest = Split-Path $src -Parent }
    New-Item -ItemType Directory -Force $Dest | Out-Null
    $dest = (Resolve-Path $Dest).Path
    $zip = Join-Path $dest ("{0}-{1}.plistoplugin" -f $manifest.id, $manifest.version)
    if ($zip.StartsWith($src + "\")) { throw "The archive would land inside the folder it packs. Use -Out." }

    $files = Get-ChildItem $src -Recurse -File | Where-Object {
        $_.Extension -ne ".plistoplugin" -and -not (Has-Dotname ($_.FullName.Substring($src.Length + 1)))
    }
    Write-Archive $src $files $zip
}

if ($Path) {
    Pack-Folder $Path $Out
}
else {
    foreach ($name in $Sample) { Pack-Sample $name $Out }
}
