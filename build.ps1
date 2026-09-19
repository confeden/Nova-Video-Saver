<#
.SYNOPSIS
  Builds the release archive Nova_Video_Saver_v<version>.zip from extension/.

.DESCRIPTION
  The version is read from extension/manifest.json, and the build fails if the
  manifest names a file that would not ship.

  Incremental: the archive of the current version - or, on the first build of a
  new version, the newest archive of an older one - is the cache. An entry whose
  bytes equal its source file is carried over still compressed, so only changed
  and new files are compressed again (ffmpeg-core.wasm alone is most of a full
  build). When nothing changed the archive is not rewritten at all, so its
  sha256 stays that of the asset already uploaded.

  After a successful build the archives of every other version and the leftovers
  of interrupted builds are deleted; the current archive stays as the next cache.

.PARAMETER Clean
  Ignore the cached archives and compress every file.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
#>
[CmdletBinding()]
param([switch]$Clean)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$clock = [Diagnostics.Stopwatch]::StartNew()
$root = $PSScriptRoot
$source = Join-Path $root 'extension'
# In the repository but not in manifest.json: Musify is disabled (ROADMAP S16).
$excluded = @('musify.js', 'musify.css')
$junk = @('Thumbs.db', 'desktop.ini', '.DS_Store')
$prefix = 'Nova_Video_Saver_v'
$archivePattern = '^~?' + [regex]::Escape($prefix) + '\d+(\.\d+){0,3}\.zip$'

function Get-ManifestPaths($node) {
    if ($node -is [string]) {
        if ($node -match '^/?[\w./-]+\.(js|mjs|css|html|json|png|svg|jpg|webp|wasm)$') { $node.TrimStart('/') }
    } elseif ($node -is [array]) {
        foreach ($item in $node) { Get-ManifestPaths $item }
    } elseif ($node -is [Management.Automation.PSCustomObject]) {
        foreach ($property in $node.PSObject.Properties) { Get-ManifestPaths $property.Value }
    }
}

function Get-StreamHash([IO.Stream]$stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $sha.Dispose(); $stream.Dispose() }
}

$manifest = [IO.File]::ReadAllText((Join-Path $source 'manifest.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+(\.\d+){0,3}$') { throw "manifest.json: unusable version '$version'" }

# Entry names are compared ordinally: a zip is case-sensitive even where NTFS is not.
$files = New-Object 'Collections.Generic.Dictionary[string,IO.FileInfo]' ([StringComparer]::Ordinal)
$sourcePrefix = $source.TrimEnd('\') + '\'
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
    $name = $file.FullName.Substring($sourcePrefix.Length).Replace('\', '/')
    if ($excluded -notcontains $name -and $junk -notcontains $file.Name) { $files[$name] = $file }
}
$unshipped = @(Get-ManifestPaths $manifest | Where-Object { -not $files.ContainsKey($_) } | Sort-Object -Unique)
if ($unshipped) { throw "manifest.json names files that would not ship: $($unshipped -join ', ')" }

$target = Join-Path $root "$prefix$version.zip"
$partial = Join-Path $root "~$prefix$version.zip"
$base = $null
if (-not $Clean) {
    $cached = @(Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match $archivePattern -and $_.Name[0] -ne '~' })
    $base = @($cached | Where-Object { $_.FullName -eq $target }) + @($cached | Sort-Object LastWriteTime -Descending) | Select-Object -First 1
}

# Cached entries that can be carried over: the first entry of each name whose content equals the source file.
$keep = New-Object 'Collections.Generic.HashSet[int]'
$reused = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
$entryCount = 0
if ($base) {
    try {
        $zip = [IO.Compression.ZipFile]::OpenRead($base.FullName)
        try {
            $entryCount = $zip.Entries.Count
            for ($i = 0; $i -lt $entryCount; $i++) {
                $entry = $zip.Entries[$i]
                $file = $null
                if (-not $files.TryGetValue($entry.FullName, [ref]$file) -or $reused.Contains($entry.FullName)) { continue }
                if ($entry.Length -ne $file.Length) { continue }
                if ((Get-StreamHash ($entry.Open())) -ne (Get-StreamHash ([IO.File]::OpenRead($file.FullName)))) { continue }
                [void]$keep.Add($i)
                [void]$reused.Add($entry.FullName)
            }
        } finally { $zip.Dispose() }
    } catch {
        Write-Warning "cache $($base.Name) is unusable, compressing everything: $($_.Exception.Message)"
        $base = $null
        $keep.Clear()
        $reused.Clear()
    }
}

$upToDate = $base -and $base.FullName -eq $target -and $keep.Count -eq $entryCount -and $reused.Count -eq $files.Count
$compress = @($files.Keys | Where-Object { -not $reused.Contains($_) } | Sort-Object)
if (-not $upToDate) {
    try {
        if ($base) {
            Copy-Item -LiteralPath $base.FullName -Destination $partial -Force
            $zip = [IO.Compression.ZipFile]::Open($partial, [IO.Compression.ZipArchiveMode]::Update)
        } else {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            $zip = [IO.Compression.ZipFile]::Open($partial, [IO.Compression.ZipArchiveMode]::Create)
        }
        try {
            if ($base) {
                # Update mode writes the untouched entries back from their compressed bytes, without recompressing.
                # (Create mode has no Entries to read.)
                $entries = @($zip.Entries)
                for ($i = 0; $i -lt $entries.Count; $i++) { if (-not $keep.Contains($i)) { $entries[$i].Delete() } }
            }
            foreach ($name in $compress) {
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $files[$name].FullName, $name, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally { $zip.Dispose() }

        # Exactly one entry per file, each with the file's length.
        $zip = [IO.Compression.ZipFile]::OpenRead($partial)
        try {
            $matched = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
            foreach ($entry in $zip.Entries) {
                if ($files.ContainsKey($entry.FullName) -and $entry.Length -eq $files[$entry.FullName].Length) { [void]$matched.Add($entry.FullName) }
            }
            if ($matched.Count -ne $files.Count -or $zip.Entries.Count -ne $files.Count) {
                throw "archive check failed: $($zip.Entries.Count) entries, $($matched.Count) of $($files.Count) files match"
            }
        } finally { $zip.Dispose() }

        if (Test-Path -LiteralPath $target) {
            [IO.File]::Replace($partial, $target, [NullString]::Value)
        } else {
            [IO.File]::Move($partial, $target)
        }
    } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        throw
    }
}

# Only after a successful build: the other versions' archives were caches, not artifacts.
foreach ($stale in @(Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match $archivePattern -and $_.FullName -ne $target })) {
    Remove-Item -LiteralPath $stale.FullName -Force
    "removed $($stale.Name)"
}

$archive = Get-Item -LiteralPath $target
$state = if ($upToDate) { 'up to date' } elseif ($base) { "updated from $($base.Name)" } else { 'built from scratch' }
'{0}: {1}' -f $archive.Name, $state
'  {0} entries ({1} reused, {2} compressed), {3:N0} B, {4:N2} s' -f $files.Count, $reused.Count, $compress.Count, $archive.Length, $clock.Elapsed.TotalSeconds
'  sha256 {0}' -f (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
