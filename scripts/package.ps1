$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $projectRoot 'release'
$stagingRoot = Join-Path $releaseRoot 'Maps-Lead-Finder'
# Only delete this exact generated staging directory, contained in this project.
$resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
$expectedStaging = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release\Maps-Lead-Finder'))
if ($resolvedStaging -ne $expectedStaging -or -not $resolvedStaging.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Unexpected packaging path.' }
if (Test-Path -LiteralPath $resolvedStaging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
New-Item -ItemType Directory -Path $resolvedStaging -Force | Out-Null
foreach ($item in @('manifest.json', 'README.md', 'TESTING.md', 'src', 'styles', 'vendor')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $resolvedStaging -Recurse
}
$zipPath = Join-Path $releaseRoot 'Maps-Lead-Finder.zip'
Compress-Archive -LiteralPath $resolvedStaging -DestinationPath $zipPath -Force
Write-Output "Created $zipPath"
