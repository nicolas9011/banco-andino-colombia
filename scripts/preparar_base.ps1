<#
.SYNOPSIS
  Deja la base lista desde cero: esquema, personal, 1.000.000 de transacciones sinteticas, demo y controles.
.DESCRIPTION
  Orden (importa): 1) reconstruir  2) seed usuarios  3) carga masiva  4) seed demo  5) cierre diario  6) compuertas.
  La demo va DESPUES de la masiva porque escribe movimientos con la fecha de hoy, que deben quedar al
  final del libro mayor; el personal va ANTES porque el historial los usa como actor de ventanilla.
  Uso:  powershell -File scripts\preparar_base.ps1 [-Rapido]
  -Rapido carga 500 clientes / 2.500 cuentas / 50.000 transacciones (para pruebas).
#>
param([switch]$Rapido)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

function Paso($texto, [scriptblock]$bloque) {
    Write-Host "`n=== $texto ===" -ForegroundColor Cyan
    & $bloque
    if ($LASTEXITCODE -ne 0) { throw "Fallo en: $texto (codigo $LASTEXITCODE)" }
}

Paso '1/6 Reconstruir esquema' { python src/reconstruir.py }
Paso '2/6 Personal (admin, auditor, cajeros)' { npm --prefix backend run seed -- usuarios }
if ($Rapido) {
    Paso '3/6 Carga masiva (rapida)' { python -X utf8 src/masivo.py --clientes 500 --cuentas 2500 --transacciones 50000 }
} else {
    Paso '3/6 Carga masiva (10.000 / 50.000 / 1.000.000)' { python -X utf8 src/masivo.py }
}
Paso '4/6 Clientes de demostracion' { npm --prefix backend run seed -- demo }
Paso '5/6 Cierre diario del historial (CALL api.cerrar_dia por cada dia)' { python -X utf8 src/cerrar_historico.py }
Paso '6/6 Controles de calidad de datos' { python -X utf8 src/compuertas.py --json }
Write-Host "`nBase lista." -ForegroundColor Green
