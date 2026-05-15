$ErrorActionPreference = "Stop"

function Resolve-DoclingPrefix {
    if ($env:DOCLING_CONDA_PREFIX) {
        return $env:DOCLING_CONDA_PREFIX
    }
    if ($env:WASABI_CONDA_PREFIX) {
        return $env:WASABI_CONDA_PREFIX
    }

    $payload = conda env list --json | ConvertFrom-Json
    foreach ($envPath in $payload.envs) {
        if ($envPath -match '[\\/ ]envs[\\/ ]docling$') {
            return $envPath
        }
    }

    throw "Unable to locate docling conda env. Set DOCLING_CONDA_PREFIX or WASABI_CONDA_PREFIX."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$doclingPrefix = Resolve-DoclingPrefix

Write-Host "[pdf-regression] repo: $repoRoot"
Write-Host "[pdf-regression] docling prefix: $doclingPrefix"

Push-Location $repoRoot
try {
    Write-Host "[pdf-regression] CLI help smoke check"
    conda run -p $doclingPrefix python src/pdf/translate_pdf.py --help | Out-Null

    Write-Host "[pdf-regression] Python regression checks"
    conda run -p $doclingPrefix python tests/pdf_regression_check.py

    Write-Host "[pdf-regression] done"
}
finally {
    Pop-Location
}
