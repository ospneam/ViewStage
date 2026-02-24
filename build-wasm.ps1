# ViewStage WASM Build Script
# Automatically compiles the WASM module and copies it to the src directory

param(
    [string]$Mode = "release",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WasmDir = Join-Path $ScriptDir "wasm-viewstage"
$OutputDir = Join-Path $ScriptDir "src\wasm"

function Write-Status {
    param([string]$Message)
    Write-Host "[ViewStage] $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[ViewStage] $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ViewStage] ERROR: $Message" -ForegroundColor Red
}

if ($Help) {
    Write-Host @"
ViewStage WASM Build Script

Usage: .\build-wasm.ps1 [-Mode <mode>] [-Help]

Options:
    -Mode       Build mode: 'release' (default) or 'dev'
    -Help       Show this help message

Examples:
    .\build-wasm.ps1              # Build in release mode
    .\build-wasm.ps1 -Mode dev    # Build in development mode
"@
    exit 0
}

Write-Status "Starting WASM build process..."
Write-Status "Build mode: $Mode"

# Check if wasm-pack is installed
Write-Status "Checking for wasm-pack..."
$wasmPack = Get-Command wasm-pack -ErrorAction SilentlyContinue
if (-not $wasmPack) {
    Write-Error "wasm-pack is not installed!"
    Write-Host ""
    Write-Host "Please install wasm-pack using one of the following methods:"
    Write-Host "  1. cargo install wasm-pack"
    Write-Host "  2. Invoke-WebRequest -Uri 'https://rustwasm.github.io/wasm-pack/installer/init.ps1' -OutFile 'install.ps1'; .\install.ps1"
    exit 1
}
Write-Success "wasm-pack found: $($wasmPack.Source)"

# Check if the wasm-viewstage directory exists
if (-not (Test-Path $WasmDir)) {
    Write-Error "wasm-viewstage directory not found: $WasmDir"
    exit 1
}

# Create output directory if it doesn't exist
if (-not (Test-Path $OutputDir)) {
    Write-Status "Creating output directory: $OutputDir"
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Build WASM
Write-Status "Building WASM module..."
$buildTarget = if ($Mode -eq "dev") { "dev" } else { "release" }
$buildArgs = @(
    "build",
    "--target", "web",
    "--$buildTarget",
    "--out-dir", $OutputDir
)

Push-Location $WasmDir
try {
    $startTime = Get-Date
    
    & wasm-pack @buildArgs
    
    if ($LASTEXITCODE -ne 0) {
        throw "wasm-pack build failed with exit code $LASTEXITCODE"
    }
    
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    Write-Success "WASM build completed in $($duration.TotalSeconds.ToString('F2')) seconds"
}
catch {
    Write-Error "Build failed: $_"
    Pop-Location
    exit 1
}
finally {
    Pop-Location
}

# Verify output files
$expectedFiles = @(
    "wasm_viewstage.js",
    "wasm_viewstage_bg.wasm"
)

$missingFiles = @()
foreach ($file in $expectedFiles) {
    $filePath = Join-Path $OutputDir $file
    if (-not (Test-Path $filePath)) {
        $missingFiles += $file
    }
}

if ($missingFiles.Count -gt 0) {
    Write-Error "Missing output files: $($missingFiles -join ', ')"
    exit 1
}

# Show output file sizes
Write-Status "Output files:"
foreach ($file in $expectedFiles) {
    $filePath = Join-Path $OutputDir $file
    $fileInfo = Get-Item $filePath
    $sizeKB = [math]::Round($fileInfo.Length / 1KB, 2)
    Write-Host "  - $file ($sizeKB KB)"
}

# Generate TypeScript definitions if needed (optional)
$tsDefPath = Join-Path $OutputDir "wasm_viewstage.d.ts"
if (Test-Path $tsDefPath) {
    Write-Status "TypeScript definitions generated"
}

Write-Success "WASM build completed successfully!"
Write-Status "Output directory: $OutputDir"
