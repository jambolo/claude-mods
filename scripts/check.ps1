# Validates the marketplace and every mod it lists, runs each mod's tests, and
# flags a mod folder the marketplace does not list.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$marketplace = Get-Content (Join-Path $root '.claude-plugin/marketplace.json') -Raw | ConvertFrom-Json
$failed = [System.Collections.Generic.List[string]]::new()
$listed = [System.Collections.Generic.List[string]]::new()

claude plugin validate $root | Out-Host
if ($LASTEXITCODE -ne 0) { $failed.Add('marketplace') }

foreach ($plugin in $marketplace.plugins) {
    $dir = Join-Path $root $plugin.source
    if (-not (Test-Path $dir)) {
        $failed.Add("$($plugin.name): $($plugin.source) does not exist")
        continue
    }
    $dir = (Resolve-Path $dir).Path
    $listed.Add($dir)

    claude plugin validate $dir | Out-Host
    if ($LASTEXITCODE -ne 0) { $failed.Add("$($plugin.name): validate") }

    $tests = Get-ChildItem $dir -Recurse -File -Include '*.test.ts', '*.test.tsx' |
        Where-Object FullName -NotMatch '[\\/]\.claude-plugin[\\/]'
    if ($tests) {
        claude plugin test $dir | Out-Host
        if ($LASTEXITCODE -ne 0) { $failed.Add("$($plugin.name): test") }
    }
}

# A mod folder the marketplace does not list cannot be installed.
Get-ChildItem $root -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName '.claude-plugin/plugin.json') } |
    Where-Object { $listed -notcontains $_.FullName } |
    ForEach-Object { $failed.Add("$($_.Name): not listed in marketplace.json") }

if ($failed.Count -gt 0) {
    Write-Error "Failed: $($failed -join '; ')"
}
Write-Host 'All mods passed.'
