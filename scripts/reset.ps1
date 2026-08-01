# B13 — Reset script for Windows (PowerShell)
# Returns everything to a clean known state in one command.
# Usage: .\scripts\reset.ps1

$ErrorActionPreference = "Stop"

$CORE_URL = $env:CORE_URL ?? "http://localhost:4000"
$VENDORSIM_URL = $env:VENDORSIM_URL ?? "http://localhost:4100"

Write-Host ""
Write-Host "╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  LAKSHMAN REKHA — Reset to clean state    ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check services are up ────────────────────────────────
Write-Host "▸ Checking services..." -ForegroundColor Yellow
try {
    $null = Invoke-WebRequest -Uri "$CORE_URL/health" -UseBasicParsing -TimeoutSec 3
    Write-Host "  ✓ Core is up" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Core is not running at $CORE_URL" -ForegroundColor Red
    Write-Host "    Run: docker compose up -d"
    exit 1
}

try {
    $null = Invoke-WebRequest -Uri "$VENDORSIM_URL/catalog" -UseBasicParsing -TimeoutSec 3
    Write-Host "  ✓ Vendorsim is up" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Vendorsim is not running at $VENDORSIM_URL" -ForegroundColor Red
    Write-Host "    Run: docker compose up -d"
    exit 1
}

# ── 2. Restart services to clear state ──────────────────────
Write-Host "▸ Restarting services..." -ForegroundColor Yellow
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker compose restart vendorsim 2>&1 | Out-Null
        Write-Host "  ✓ Vendorsim restarted" -ForegroundColor Green
    } catch {
        Write-Host "  ~ Vendorsim not in Docker (skipping)" -ForegroundColor Gray
    }
    try {
        docker compose restart core 2>&1 | Out-Null
        Write-Host "  ✓ Core restarted" -ForegroundColor Green
    } catch {
        Write-Host "  ~ Core not in Docker (skipping)" -ForegroundColor Gray
    }
}

# ── 3. Wait for core to come back ───────────────────────────
Write-Host "  Waiting for core to be healthy..." -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $null = Invoke-WebRequest -Uri "$CORE_URL/health" -UseBasicParsing -TimeoutSec 2
        $ok = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if ($ok) {
    Write-Host "  ✓ Core is healthy" -ForegroundColor Green
} else {
    Write-Host "  ✗ Core did not come back in time" -ForegroundColor Red
}

# ── 4. Verify catalog ───────────────────────────────────────
Write-Host "▸ Verifying vendor catalog..." -ForegroundColor Yellow
try {
    $catalog = Invoke-WebRequest -Uri "$VENDORSIM_URL/catalog" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
    Write-Host "  ✓ $($catalog.Count) vendors in catalog (should be 8)" -ForegroundColor Green
} catch {
    Write-Host "  ~ Could not verify catalog" -ForegroundColor Gray
}

Write-Host ""
Write-Host "╔═══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  Reset complete. Demo state is clean.     ║" -ForegroundColor Green
Write-Host "║  Demo credentials: see README.md          ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
