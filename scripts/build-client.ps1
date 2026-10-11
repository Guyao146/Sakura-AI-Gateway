$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'client'
$nodePath = (Get-Command node.exe).Source
$rootPath = [System.IO.Path]::GetFullPath($root)
$outputPath = [System.IO.Path]::GetFullPath($output)
if (-not $outputPath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output path is outside the project: $outputPath"
}

if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}

dotnet publish (Join-Path $root 'desktop-client\Sakura-AI-Gateway.Client.csproj') `
    -c Release `
    -o $output
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Copy-Item -LiteralPath $nodePath -Destination (Join-Path $output 'node.exe')
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $output

Get-ChildItem -LiteralPath $output -Recurse -File |
    Where-Object { $_.Extension -in '.pdb', '.xml' } |
    Remove-Item -Force

foreach ($architecture in @('win-x86', 'win-arm64')) {
    $runtimeDirectory = Join-Path $output "runtimes\$architecture"
    if (Test-Path -LiteralPath $runtimeDirectory) {
        Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
    }
}

$archive = Join-Path $root 'Sakura-AI-Gateway-client-win64.zip'
if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}
Compress-Archive -Path (Join-Path $output '*') -DestinationPath $archive

Write-Host "Client built: $output"
Write-Host "Client archive: $archive"
