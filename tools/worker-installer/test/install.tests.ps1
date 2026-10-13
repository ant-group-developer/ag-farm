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

$setup = [pscustomobject]@{ ok = $true; python_bin = 'C:\ag-farm\venv\Scripts\python.exe'; ytdlp_bin = 'C:\ag-farm\venv\Scripts\yt-dlp.exe'; hf_home = 'C:\ag-farm\models'; errors = @() }
$re = Get-AgRenderExtra -SetupResult $setup
Assert-Equal 'render extra: python_bin from setup' $re['python_bin'] 'C:\ag-farm\venv\Scripts\python.exe'
Assert-Equal 'render extra: ytdlp_bin from setup' $re['ytdlp_bin'] 'C:\ag-farm\venv\Scripts\yt-dlp.exe'
Assert-Equal 'render extra: hf_home from setup' $re['hf_home'] 'C:\ag-farm\models'
Assert-Equal 'render extra: encoder' $re['encoder'] 'auto'
Assert-Equal 'render extra: unload ollama' $re['unload_ollama_before_tts'] $true
$re = Get-AgRenderExtra -SetupResult ([pscustomobject]@{ ok = $false; python_bin = $null; ytdlp_bin = $null; hf_home = 'C:\ag-farm\models'; errors = @('python: x') })
Assert-Equal 'render extra: failed setup leaves python_bin unknown' ($null -eq $re['python_bin']) $true
Assert-Equal 'render extra: old package (no setup) still sets encoder' (Get-AgRenderExtra -SetupResult $null)['encoder'] 'auto'

function Get-YamlKeyLines($Yaml, $Pattern) { ,@(($Yaml -split "`r`n") | Where-Object { $_ -match $Pattern }) }

$fresh = New-AgConfigYaml -Hub 'http://hub' -Node $node -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra ([ordered]@{ encoder = 'auto'; python_bin = 'C:\ag-farm\venv\Scripts\python.exe' }) -OmitKinds
Assert-Equal 'new package: fresh config has no kinds' (Get-YamlKeyLines $fresh '^kinds:').Count 0
Assert-Equal 'fresh config: extra python_bin' (Get-YamlKeyLines $fresh '^  python_bin:')[0] "  python_bin: 'C:\ag-farm\venv\Scripts\python.exe'"

# Config của máy cài bằng bản cũ, người dùng đã sửa vài chỗ
$old = @(
  '# Cau hinh worker (install.ps1 tao). Token chi hien o day, dung chia se file nay.',
  "hub_url: 'http://old-hub:3010'",
  "token: 'tok-old-000000000000000000000'",
  "name: 'lan-4060ti-render'",
  'kinds:',
  '  - studio.tts',
  '  - studio.render_final',
  "work_dir: 'C:\ag-farm\render\work'",
  'cache:',
  "  dir: 'D:\big-cache'",
  '  max_gb: 77',
  "machine_file: 'C:\ProgramData\ag-farm\machine.yaml'",
  '# lich rieng cua anh Duc',
  'schedule:',
  "  - { days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' }",
  'my_note: keep me',
  'extra:',
  "  encoder: 'cpu'",
  "  python_bin: 'D:\ag-farm\venv\Scripts\python.exe'",
  '  # GPU 4 GB',
  '  transcribe_compute_type: int8_float16',
  '  transcribe_batch_size: 4',
  ''
) -join "`r`n"
$managed = Get-AgRenderExtra -SetupResult ([pscustomobject]@{ ok = $true; python_bin = 'C:\ag-farm\venv\Scripts\python.exe'; ytdlp_bin = 'C:\ag-farm\venv\Scripts\yt-dlp.exe'; hf_home = 'C:\ag-farm\models' })
$updNode = [pscustomobject]@{ role = 'render'; name = 'lan-4060ti-render'; token = 'tok-old-000000000000000000000'; kinds = @() }
$upd = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $old -OmitKinds
Assert-Equal 'update: kinds dropped' (Get-YamlKeyLines $upd '^kinds:|^  - studio').Count 0
Assert-Equal 'update: hub_url kept' (Get-YamlKeyLines $upd '^hub_url:')[0] "hub_url: 'http://old-hub:3010'"
Assert-Equal 'update: token kept' (Get-YamlKeyLines $upd '^token:')[0] "token: 'tok-old-000000000000000000000'"
Assert-Equal 'update: cache kept' ((Get-YamlKeyLines $upd '^  (dir|max_gb):') -join '|') "  dir: 'D:\big-cache'|  max_gb: 77"
Assert-Equal 'update: schedule and its comment kept' ((Get-YamlKeyLines $upd '^# lich|^schedule:|days:').Count) 3
Assert-Equal 'update: unknown top-level key kept' (Get-YamlKeyLines $upd '^my_note:')[0] 'my_note: keep me'
Assert-Equal 'update: managed encoder rewritten' (Get-YamlKeyLines $upd '^  encoder:')[0] "  encoder: 'auto'"
Assert-Equal 'update: python_bin moves to the new venv' (Get-YamlKeyLines $upd '^  python_bin:')[0] "  python_bin: 'C:\ag-farm\venv\Scripts\python.exe'"
Assert-Equal 'update: ytdlp_bin added' (Get-YamlKeyLines $upd '^  ytdlp_bin:')[0] "  ytdlp_bin: 'C:\ag-farm\venv\Scripts\yt-dlp.exe'"
Assert-Equal 'update: hf_home added' (Get-YamlKeyLines $upd '^  hf_home:')[0] "  hf_home: 'C:\ag-farm\models'"
Assert-Equal 'update: user extra keys and comments kept' ((Get-YamlKeyLines $upd '^  (transcribe_compute_type|transcribe_batch_size|# GPU 4 GB)').Count) 3
Assert-Equal 'update: each key once' (Get-YamlKeyLines $upd '^(hub_url|token|name|work_dir|cache|machine_file|extra):').Count 7
$again = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $upd -OmitKinds
Assert-Equal 'update twice changes nothing' ($again -eq $upd) $true

$failed = Get-AgRenderExtra -SetupResult ([pscustomobject]@{ ok = $false; python_bin = $null; ytdlp_bin = $null; hf_home = $null })
$upd2 = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $failed -Existing $old -OmitKinds
Assert-Equal 'failed setup keeps the old python_bin' (Get-YamlKeyLines $upd2 '^  python_bin:')[0] "  python_bin: 'D:\ag-farm\venv\Scripts\python.exe'"
Assert-Equal 'failed setup adds no ytdlp_bin' (Get-YamlKeyLines $upd2 '^  ytdlp_bin:').Count 0

$oldPkg = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $old
Assert-Equal 'old package: update keeps its kinds' ((Get-YamlKeyLines $oldPkg '^kinds:|^  - studio').Count) 3

$reNode = [pscustomobject]@{ role = 'render'; name = 'lan-4060ti-render-2'; token = 'tok-new-000000000000000000000'; kinds = @('studio.tts') }
$re = New-AgConfigYaml -Hub 'https://new-hub' -Node $reNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $old -Enrolled -OmitKinds
Assert-Equal 're-enroll: new token' (Get-YamlKeyLines $re '^token:')[0] "token: 'tok-new-000000000000000000000'"
Assert-Equal 're-enroll: new name' (Get-YamlKeyLines $re '^name:')[0] "name: 'lan-4060ti-render-2'"
Assert-Equal 're-enroll: new hub' (Get-YamlKeyLines $re '^hub_url:')[0] "hub_url: 'https://new-hub'"
Assert-Equal 're-enroll: user keys kept' (Get-YamlKeyLines $re '^my_note:').Count 1

$flow = New-AgConfigYaml -Hub 'h' -Node $updNode -RoleDir 'C:\r' -CacheDir 'C:\c' -CacheGb 10 -MachineFile 'C:\m.yaml' `
  -Extra ([ordered]@{ encoder = 'auto' }) -Existing "name: 'x'`r`ntoken: 'y'`r`nextra: {}"
Assert-Equal 'extra: {} becomes a block' ((Get-YamlKeyLines $flow '^extra:$|^  encoder:').Count) 2

Assert-Equal 'render 0.8.1 needs kinds' (Test-AgKindsOptional 'ag-render-worker' '0.8.1') $false
Assert-Equal 'render 0.9.0 computes kinds' (Test-AgKindsOptional 'ag-render-worker' '0.9.0') $true
Assert-Equal 'render 0.10.0 computes kinds' (Test-AgKindsOptional 'ag-render-worker' '0.10.0') $true
Assert-Equal 'render 0.9.0-rc.1 computes kinds' (Test-AgKindsOptional 'ag-render-worker' '0.9.0-rc.1') $true
Assert-Equal 'scan 0.3.5 needs kinds' (Test-AgKindsOptional 'ag-scan-worker' '0.3.5') $false
Assert-Equal 'scan 0.4.0 computes kinds' (Test-AgKindsOptional 'ag-scan-worker' '0.4.0') $true
Assert-Equal 'unknown package needs kinds' (Test-AgKindsOptional 'other' '9.9.9') $false

# ---- Tự cập nhật ----

Assert-Equal 'version: newer minor' ([Math]::Sign((Compare-AgVersion '0.9.0' '0.8.1'))) 1
Assert-Equal 'version: 0.10 after 0.9' ([Math]::Sign((Compare-AgVersion '0.10.0' '0.9.9'))) 1
Assert-Equal 'version: same' (Compare-AgVersion '0.9.0' '0.9.0') 0
Assert-Equal 'version: rc before release' ([Math]::Sign((Compare-AgVersion '0.9.0-rc.1' '0.9.0'))) -1
Assert-Equal 'version: rc.2 before rc.10' ([Math]::Sign((Compare-AgVersion '0.9.0-rc.2' '0.9.0-rc.10'))) -1
Assert-Equal 'version: unreadable installed version is older' ([Math]::Sign((Compare-AgVersion '0.9.0' $null))) 1

$latestJson = [pscustomobject]@{ packages = [pscustomobject]@{
  'ag-render-worker' = [pscustomobject]@{ version = '0.9.1' }
  'ag-scan-worker' = [pscustomobject]@{ version = '0.4.0' }
} }
$both = @{ render = '0.9.0'; scan = '0.4.0' }
Assert-Equal 'select: newer render, nothing asked (nightly), allowed' ((Select-AgUpdateRoles -Installed $both -Latest $latestJson -Requests @{} -AutoUpdate @{} -LastResults @{}) -join ',') 'render'
Assert-Equal 'select: scan already latest' ((Select-AgUpdateRoles -Installed @{ scan = '0.4.0' } -Latest $latestJson -Requests @{ scan = @{} } -AutoUpdate @{} -LastResults @{}).Count) 0
Assert-Equal 'select: hub turned auto-update off' ((Select-AgUpdateRoles -Installed $both -Latest $latestJson -Requests @{} -AutoUpdate @{ render = $false } -LastResults @{}).Count) 0
Assert-Equal 'select: the worker asked (update now) even with auto-update off' ((Select-AgUpdateRoles -Installed $both -Latest $latestJson -Requests @{ render = @{} } -AutoUpdate @{ render = $false } -LastResults @{}) -join ',') 'render'
$failedLast = @{ render = [pscustomobject]@{ state = 'failed'; target_version = '0.9.1' } }
Assert-Equal 'select: nightly run skips a version that failed here' ((Select-AgUpdateRoles -Installed $both -Latest $latestJson -Requests @{} -AutoUpdate @{} -LastResults $failedLast).Count) 0
Assert-Equal 'select: a request retries it' ((Select-AgUpdateRoles -Installed $both -Latest $latestJson -Requests @{ render = @{} } -AutoUpdate @{} -LastResults $failedLast) -join ',') 'render'
Assert-Equal 'select: order scan then render' ((Select-AgUpdateRoles -Installed @{ render = '0.8.1'; scan = '0.3.5' } -Latest $latestJson -Requests @{} -AutoUpdate @{} -LastResults @{}) -join ',') 'scan,render'
Assert-Equal 'select: package missing from latest.json' ((Select-AgUpdateRoles -Installed @{ render = '0.9.0' } -Latest ([pscustomobject]@{ packages = [pscustomobject]@{} }) -Requests @{ render = @{} } -AutoUpdate @{} -LastResults @{}).Count) 0

$withUpdater = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $old -OmitKinds -UpdaterDir 'C:\ag-farm\updater'
Assert-Equal 'updater: task name added' (Get-YamlKeyLines $withUpdater '^updater_task:')[0] "updater_task: 'ag-farm-updater'"
Assert-Equal 'updater: dir added' (Get-YamlKeyLines $withUpdater '^updater_dir:')[0] "updater_dir: 'C:\ag-farm\updater'"
Assert-Equal 'updater: check minutes added' (Get-YamlKeyLines $withUpdater '^update_check_minutes:')[0] 'update_check_minutes: 15'
Assert-Equal 'updater: drain minutes added' (Get-YamlKeyLines $withUpdater '^update_drain_minutes:')[0] 'update_drain_minutes: 30'
$userDrain = $withUpdater -replace 'update_drain_minutes: 30', 'update_drain_minutes: 90'
$again = New-AgConfigYaml -Hub 'https://new-hub' -Node $updNode -RoleDir 'C:\ag-farm\render' -CacheDir 'C:\ag-farm\cache\render' -CacheGb 40 `
  -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra $managed -Existing $userDrain -OmitKinds -UpdaterDir 'C:\ag-farm\updater'
Assert-Equal 'updater: the drain minutes someone set are kept' (Get-YamlKeyLines $again '^update_drain_minutes:')[0] 'update_drain_minutes: 90'
Assert-Equal 'updater: second update changes nothing' ($again -eq $userDrain) $true

$wrapper = New-AgUpdaterScript -InstallDir 'C:\ag farm'
[System.Management.Automation.Language.Parser]::ParseInput($wrapper, [ref]$tokens, [ref]$errors) | Out-Null
Assert-Equal 'update.ps1 parses' $errors.Count 0
Assert-Equal 'update.ps1 runs the auto-update of its install dir' ($wrapper -match "Invoke-AgAutoUpdate -InstallDir 'C:\\ag farm'") $true

# Thay app giữ app.prev, quay về được
$roleDir = Join-Path $tmp 'render'
function New-TestPackageZip([string]$Version) {
  $src = Join-Path $tmp "pkg-$Version\ag-render-worker-$Version"
  New-Item -ItemType Directory -Force -Path $src | Out-Null
  [IO.File]::WriteAllText((Join-Path $src 'package.json'), "{ `"name`": `"x`", `"version`": `"$Version`" }")
  $zip = Join-Path $tmp "ag-render-worker-$Version.zip"
  Remove-Item -Force -LiteralPath $zip -ErrorAction SilentlyContinue
  Compress-Archive -Path $src -DestinationPath $zip
  return $zip
}
Install-AgPackageZip -Zip (New-TestPackageZip '0.9.0') -RoleDir $roleDir
Assert-Equal 'first install: app' (Get-AgInstalledVersion (Join-Path $roleDir 'app')) '0.9.0'
Assert-Equal 'first install: no app.prev' (Test-Path (Join-Path $roleDir 'app.prev')) $false
Install-AgPackageZip -Zip (New-TestPackageZip '0.9.1') -RoleDir $roleDir
Assert-Equal 'update: new app' (Get-AgInstalledVersion (Join-Path $roleDir 'app')) '0.9.1'
Assert-Equal 'update: previous kept in app.prev' (Get-AgInstalledVersion (Join-Path $roleDir 'app.prev')) '0.9.0'
Assert-Equal 'update: staging cleaned' (Test-Path (Join-Path $roleDir 'staging')) $false
[IO.File]::WriteAllText((Join-Path $roleDir 'config.yaml'), 'new')
[IO.File]::WriteAllText((Join-Path $roleDir 'config.yaml.bak'), 'old')
Assert-Equal 'rollback: done' (Restore-AgAppDir -RoleDir $roleDir -RestoreConfig) $true
Assert-Equal 'rollback: old app back' (Get-AgInstalledVersion (Join-Path $roleDir 'app')) '0.9.0'
Assert-Equal 'rollback: config back' (Get-Content -Raw (Join-Path $roleDir 'config.yaml')) 'old'
Assert-Equal 'rollback: nothing left to roll back to' (Restore-AgAppDir -RoleDir $roleDir) $false

$updDir = Join-Path $tmp 'updater'
Write-AgUpdateResult -UpdaterDir $updDir -Role 'render' -State 'failed' -From '0.9.0' -Target '0.9.1' -Message 'no heartbeat' -RequestedAt '2026-10-12T10:00:00.000Z'
$res = Read-AgJsonFile (Join-Path $updDir 'result-render.json')
Assert-Equal 'result: state' $res.state 'failed'
Assert-Equal 'result: requested_at kept as text' $res.requested_at '2026-10-12T10:00:00.000Z'
Assert-Equal 'result: no BOM (the worker reads it)' ([IO.File]::ReadAllBytes((Join-Path $updDir 'result-render.json'))[0]) ([byte][char]'{')
[IO.File]::WriteAllText((Join-Path $tmp 'setup.log'), "line 1`r`npip install failed: torch`r`n`r`n")
Assert-Equal 'last line of setup.log' (Get-AgLastLine (Join-Path $tmp 'setup.log')) 'pip install failed: torch'

if ($OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  # Gói cũ: có kinds (config.yaml); gói mới: không có (config-nokinds.yaml)
  [IO.File]::WriteAllText((Join-Path $OutDir 'config.yaml'), $yaml, (New-Object Text.UTF8Encoding($false)))
  $noKinds = New-AgConfigYaml -Hub 'http://192.168.1.2:3010' -Node $node -RoleDir 'C:\ag-farm\scan' -CacheDir 'C:\ag-farm\cache\scan' -CacheGb 50 `
    -MachineFile 'C:\ProgramData\ag-farm\machine.yaml' -Extra ([ordered]@{ ollama_url = 'http://127.0.0.1:11434'; unload_ollama_before_tts = $true }) -OmitKinds `
    -UpdaterDir 'C:\ag-farm\updater'
  [IO.File]::WriteAllText((Join-Path $OutDir 'config-nokinds.yaml'), $noKinds, (New-Object Text.UTF8Encoding($false)))
  $plan = Get-AgSlotPlan -Cores 28 -Gpus $gpu16 -Roles @('scan', 'render')
  [IO.File]::WriteAllText((Join-Path $OutDir 'machine.yaml'), (New-AgMachineYaml $plan), (New-Object Text.UTF8Encoding($false)))
}
Remove-Item -Recurse -Force -LiteralPath $tmp

# ---- Bộ cập nhật chạy thật trên thư mục tạm; mọi thứ đụng tới máy (task, mạng, quyền) thay bằng hàm giả ----
# (Hàm giả định nghĩa sau cùng nên các test ở trên vẫn dùng hàm thật.)
$tmp = Join-Path $env:TEMP "ag-updater-test-$PID"
Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
$installDir = Join-Path $tmp 'ag-farm'
$AgMachineFile = Join-Path $tmp 'machine.yaml'
$script:latestVersion = '0.9.1'
$script:heartbeatOk = $true
$script:installCalls = @()
$script:started = @()
$script:autoUpdate = $true

function Test-AgAdmin { $true }
function Get-AgMachineInfo { [ordered]@{ os = 'windows'; cpu_cores = 8; ram_mb = 16384; gpus = @() } }
function Get-PSDrive { [pscustomobject]@{ Free = 500GB } }
function Remove-AgLegacyService { }
function Stop-AgRole { }
function Register-AgTask { }
function Register-AgUpdaterTask { }
function Save-AgUpdater { }
function Install-AgOllama { }
function Start-ScheduledTask { param([string]$TaskName) $script:started += $TaskName }
function Start-Transcript { }
function Stop-Transcript { }
function Wait-AgVersion { $script:heartbeatOk }
function Invoke-AgRenderSetup { [pscustomobject]@{ ok = $true; python_bin = 'C:\v\python.exe'; ytdlp_bin = 'C:\v\yt-dlp.exe'; hf_home = 'C:\m'; errors = @() } }
function Invoke-AgApi {
  param([string]$Method, [string]$Url, $Body, [string]$Token)
  if ($Url -like '*/dist/latest.json') {
    return [pscustomobject]@{ packages = [pscustomobject]@{ 'ag-render-worker' = [pscustomobject]@{ version = $script:latestVersion; file = 'x.zip' } } }
  }
  if ($Url -like '*/v1/worker/me') { return [pscustomobject]@{ auto_update = $script:autoUpdate; ollama_models = @() } }
  throw "unexpected $Url"
}
function Install-AgPackage {
  param([string]$Hub, $Latest, [string]$PackageName, [string]$RoleDir)
  $script:installCalls += $PackageName
  Install-AgPackageZip -Zip (New-TestPackageZip $script:latestVersion) -RoleDir $RoleDir
  return $script:latestVersion
}
function Reset-TestInstall {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $rd = Join-Path $installDir 'render'
  Install-AgPackageZip -Zip (New-TestPackageZip '0.9.0') -RoleDir $rd
  $cfg = "hub_url: 'https://hub'`r`ntoken: 'tok-000000000000000000000'`r`nname: 'pc-render'`r`nwork_dir: 'C:\w'`r`ncache:`r`n  dir: 'C:\c'`r`n  max_gb: 10`r`n"
  [IO.File]::WriteAllText((Join-Path $rd 'config.yaml'), $cfg)
  $script:installCalls = @()
  $script:started = @()
  $script:latestVersion = '0.9.1'
  $script:heartbeatOk = $true
  $script:autoUpdate = $true
}
function Write-TestRequest {
  Write-AgJsonFile -Path (Join-Path $installDir 'updater\request-render.json') -Object ([ordered]@{
    package = 'ag-render-worker'; from_version = '0.9.0'; target_version = '0.9.1'; reason = 'requested'; requested_at = '2026-10-12T10:00:00.000Z'
  })
}
$rd = Join-Path $installDir 'render'
$resultPath = Join-Path $installDir 'updater\result-render.json'

Reset-TestInstall
Write-TestRequest
Invoke-AgAutoUpdate -InstallDir $installDir
$res = Read-AgJsonFile $resultPath
Assert-Equal 'auto: the worker request is handled and removed' (Test-Path (Join-Path $installDir 'updater\request-render.json')) $false
Assert-Equal 'auto: installs the newer package' ($script:installCalls -join ',') 'ag-render-worker'
Assert-Equal 'auto: new version in app' (Get-AgInstalledVersion (Join-Path $rd 'app')) '0.9.1'
Assert-Equal 'auto: old version kept in app.prev' (Get-AgInstalledVersion (Join-Path $rd 'app.prev')) '0.9.0'
Assert-Equal 'auto: result done' "$($res.state) $($res.from_version) $($res.target_version)" 'done 0.9.0 0.9.1'
Assert-Equal 'auto: result keeps the request time' $res.requested_at '2026-10-12T10:00:00.000Z'
$cfgText = Get-Content -Raw (Join-Path $rd 'config.yaml')
Assert-Equal 'auto: config gets the updater keys' ($cfgText -match "updater_task: 'ag-farm-updater'") $true
Assert-Equal 'auto: config gets the venv from setup' ($cfgText -match "python_bin: 'C:\\v\\python.exe'") $true
Assert-Equal 'auto: previous config kept as .bak' (Test-Path (Join-Path $rd 'config.yaml.bak')) $true

Reset-TestInstall
$script:heartbeatOk = $false
Write-TestRequest
Invoke-AgAutoUpdate -InstallDir $installDir
$res = Read-AgJsonFile $resultPath
Assert-Equal 'rollback: no heartbeat from the new version -> old app back' (Get-AgInstalledVersion (Join-Path $rd 'app')) '0.9.0'
Assert-Equal 'rollback: old config back' ((Get-Content -Raw (Join-Path $rd 'config.yaml')) -match 'updater_task') $false
Assert-Equal 'rollback: worker task restarted' ($script:started -join ',') 'ag-farm-render'
Assert-Equal 'rollback: result failed for the target' "$($res.state) $($res.target_version)" 'failed 0.9.1'
Assert-Equal 'rollback: message says why' ($res.message -match 'did not send a heartbeat within 3 minutes.*rolled back to 0\.9\.0') $true

# Đêm: không ai xin, bản 0.9.1 vừa hỏng ở máy này -> bỏ qua; hub tắt tự cập nhật -> bỏ qua
$script:installCalls = @()
Invoke-AgAutoUpdate -InstallDir $installDir
Assert-Equal 'nightly: skips the version that just failed' $script:installCalls.Count 0
Reset-TestInstall
$script:autoUpdate = $false
Invoke-AgAutoUpdate -InstallDir $installDir
Assert-Equal 'nightly: auto-update off on the hub' $script:installCalls.Count 0
$script:autoUpdate = $true
Invoke-AgAutoUpdate -InstallDir $installDir
Assert-Equal 'nightly: updates when allowed' ($script:installCalls -join ',') 'ag-render-worker'

Reset-TestInstall
$script:latestVersion = '0.9.0'
Write-TestRequest
Invoke-AgAutoUpdate -InstallDir $installDir
$res = Read-AgJsonFile $resultPath
Assert-Equal 'request without a newer release: nothing installed' $script:installCalls.Count 0
Assert-Equal 'request without a newer release: says so' $res.message 'Already on the latest version (0.9.0)'

Reset-TestInstall
function Install-AgPackage { throw 'Goi x.zip tai ve bi hong (sha256 khong khop)' }
Write-TestRequest
Invoke-AgAutoUpdate -InstallDir $installDir
$res = Read-AgJsonFile $resultPath
Assert-Equal 'bad download: app untouched' (Get-AgInstalledVersion (Join-Path $rd 'app')) '0.9.0'
Assert-Equal 'bad download: no rollback of an older app.prev' ($res.message -match 'rolled back') $false
Assert-Equal 'bad download: result failed with the reason' ($res.message -match 'sha256') $true
Assert-Equal 'bad download: worker task restarted' ($script:started -join ',') 'ag-farm-render'

Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue

if ($failures -gt 0) { Write-Host "$failures test loi" -ForegroundColor Red; exit 1 }
Write-Host 'Tat ca test install.ps1 deu qua' -ForegroundColor Green
