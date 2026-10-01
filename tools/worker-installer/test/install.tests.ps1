# Test các hàm thuần của install.ps1 (không cần quyền admin, không đụng tới máy):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\worker-installer\test\install.tests.ps1 [-OutDir <thư mục>]
# Với -OutDir: ghi config.yaml/machine.yaml mẫu để check-config.mjs kiểm bằng chính loader của worker-sdk.
param([string]$OutDir)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Get-Content -Raw -Encoding UTF8 (Join-Path $here '..\install.ps1')

# Script phải parse được (chạy bằng `iwr | iex` nên lỗi cú pháp chỉ lộ ra trên máy worker)
$tokens = $null; $errors = $null
[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw "install.ps1 co loi cu phap: $($errors[0].Message) (dong $($errors[0].Extent.StartLineNumber))" }
$uninstall = Get-Content -Raw -Encoding UTF8 (Join-Path $here '..\uninstall.ps1')
[System.Management.Automation.Language.Parser]::ParseInput($uninstall, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw "uninstall.ps1 co loi cu phap: $($errors[0].Message)" }

Invoke-Expression $source

$failures = 0
function Assert-Equal($Name, $Actual, $Expected) {
  if ("$Actual" -ne "$Expected") { Write-Host "FAIL $Name`n  expected: $Expected`n  actual:   $Actual" -ForegroundColor Red; $script:failures++ }
  else { Write-Host "ok   $Name" }
}

$gpu16 = @([ordered]@{ name = 'RTX 4060 Ti'; vram_mb = 16380 })
$gpu4 = @([ordered]@{ name = 'Quadro P1000'; vram_mb = 4096 })

$p = Get-AgSlotPlan -Cores 28 -Gpus $gpu16 -Roles @('scan', 'render')
Assert-Equal 'i7-14700K scan+render: 4 CPU slots' $p.cpu_slots 4
Assert-Equal 'i7-14700K scan+render: 1 GPU slot' $p.gpu_slots 1
Assert-Equal 'render keeps 1 CPU slot' $p.reserve_cpu 1
Assert-Equal 'GPU is never reserved (1-GPU machines must still scan)' $p.reserve_gpu 0

$p = Get-AgSlotPlan -Cores 12 -Gpus $gpu4 -Roles @('scan')
Assert-Equal '12 threads: 2 CPU slots' $p.cpu_slots 2
Assert-Equal '4 GB card is a GPU slot (3b model fits)' $p.gpu_slots 1
$p = Get-AgSlotPlan -Cores 12 -Gpus @([ordered]@{ name = 'GT 1030'; vram_mb = 2048 }) -Roles @('scan')
Assert-Equal '2 GB card is not a GPU slot' $p.gpu_slots 0
Assert-Equal 'scan only: nothing reserved' $p.reserve_cpu 0

$p = Get-AgSlotPlan -Cores 4 -Gpus @() -Roles @('render')
Assert-Equal 'small machine: 1 CPU slot' $p.cpu_slots 1
Assert-Equal 'single slot is not reserved away' $p.reserve_cpu 0

$p = Get-AgSlotPlan -Cores 128 -Gpus @() -Roles @('scan')
Assert-Equal 'CPU slots capped at 6' $p.cpu_slots 6

Assert-Equal 'model for 16 GB' (Get-AgDefaultModel -Gpus $gpu16) 'qwen2.5vl:7b'
Assert-Equal 'model for 4 GB' (Get-AgDefaultModel -Gpus $gpu4) 'qwen2.5vl:3b'
Assert-Equal 'model without GPU' (Get-AgDefaultModel -Gpus @()) 'qwen2.5vl:3b'

Assert-Equal 'yaml string keeps backslashes' (ConvertTo-AgYamlString 'C:\ag-farm\scan') "'C:\ag-farm\scan'"
Assert-Equal 'yaml string doubles quotes' (ConvertTo-AgYamlString "it's") "'it''s'"

$node = [pscustomobject]@{ name = 'lan-4060ti-scan'; token = "tok'en-000000000000000000000"; kinds = @('scan.extract', 'scan.ai') }
$yaml = New-AgConfigYaml -Hub 'http://192.168.1.2:3010' -Node $node -RoleDir 'C:\ag-farm\scan' -CacheDir 'C:\ag-farm\cache\scan' -CacheGb 50 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra @{ ollama_url = 'http://127.0.0.1:11434'; unload_ollama_before_tts = $true }

$tmp = Join-Path $env:TEMP "ag-installer-test-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$cfgPath = Join-Path $tmp 'config.yaml'
[IO.File]::WriteAllText($cfgPath, $yaml, (New-Object Text.UTF8Encoding($false)))
Assert-Equal 'config token reads back' (Read-AgConfigValue $cfgPath 'token') "tok'en-000000000000000000000"
Assert-Equal 'config name reads back' (Read-AgConfigValue $cfgPath 'name') 'lan-4060ti-scan'
Assert-Equal 'config hub reads back' (Read-AgConfigValue $cfgPath 'hub_url') 'http://192.168.1.2:3010'

if ($OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $OutDir 'config.yaml'), $yaml, (New-Object Text.UTF8Encoding($false)))
  $plan = Get-AgSlotPlan -Cores 28 -Gpus $gpu16 -Roles @('scan', 'render')
  [IO.File]::WriteAllText((Join-Path $OutDir 'machine.yaml'), (New-AgMachineYaml $plan), (New-Object Text.UTF8Encoding($false)))
}
Remove-Item -Recurse -Force -LiteralPath $tmp

if ($failures -gt 0) { Write-Host "$failures test loi" -ForegroundColor Red; exit 1 }
Write-Host 'Tat ca test install.ps1 deu qua' -ForegroundColor Green
