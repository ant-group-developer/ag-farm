# ag-farm: cài hoặc cập nhật máy worker (quét / render) trên Windows, một lệnh.
#
# Mở PowerShell bằng "Run as Administrator" rồi dán lệnh lấy ở trang Máy của web farm:
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm> -Code <mã>
# Cập nhật lên bản mới (giữ cấu hình, không cần mã):
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm>
# Chạy từ file tải về:
#   iex (Get-Content -Raw -Encoding UTF8 .\install.ps1); Install-AgWorker -Hub ... -Code ...
#
# Tuỳ chọn:
#   -InstallDir C:\ag-farm   thư mục cài (mặc định C:\ag-farm)
#   -Model qwen2.5vl:7b      model Ollama cho máy quét (mặc định theo VRAM; phải trùng ANALYSIS_MODEL của ag-go)
#   -WithTts                 cài thêm Python + OmniVoice cho giọng đọc (máy render)
#   -ReconfigureSlots        tính lại machine.yaml theo cấu hình máy
#   -Yes                     không hỏi (cài Ollama, dừng worker cũ)
#
# Script làm: đổi mã lấy token trên hub, tải gói mới nhất, tự tính số slot, cài Ollama + model (máy quét),
# chạy mỗi vai trò thành một task hệ thống (tự chạy khi bật máy, tự chạy lại khi chết), chờ máy Online.

function Get-AgMachineInfo {
  $cores = [int](Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
  $ramMb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  $gpus = @()
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($smi) {
    $lines = & $smi.Source --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
    foreach ($line in $lines) {
      $parts = $line.Split(',')
      if ($parts.Count -ge 2) { $gpus += [ordered]@{ name = $parts[0].Trim(); vram_mb = [int]$parts[1].Trim() } }
    }
  }
  return [ordered]@{ os = 'windows'; cpu_cores = $cores; ram_mb = $ramMb; gpus = $gpus }
}

# Số slot của máy. CPU: mỗi slot là một ffmpeg dùng nhiều luồng, nên khoảng 6 luồng một slot, 1-6 slot.
# GPU: số card NVIDIA có >= 6 GB. Máy có vai trò render thì giữ 1 slot CPU cho render; GPU không giữ riêng
# (máy 1 GPU sẽ không quét được) mà job quét nhường GPU khi render cần.
function Get-AgSlotPlan {
  param([int]$Cores, [object[]]$Gpus, [string[]]$Roles)
  $cpu = [Math]::Max(1, [Math]::Min(6, [Math]::Floor($Cores / 6)))
  $gpu = @($Gpus | Where-Object { $_.vram_mb -ge 6000 }).Count
  $reserveCpu = 0
  if (($Roles -contains 'render') -and $cpu -gt 1) { $reserveCpu = 1 }
  return [ordered]@{ cpu_slots = [int]$cpu; gpu_slots = [int]$gpu; reserve_cpu = [int]$reserveCpu; reserve_gpu = 0 }
}

function Get-AgDefaultModel {
  param([object[]]$Gpus)
  $maxVram = 0
  foreach ($g in $Gpus) { if ($g.vram_mb -gt $maxVram) { $maxVram = $g.vram_mb } }
  if ($maxVram -ge 12000) { return 'qwen2.5vl:7b' }
  return 'qwen2.5vl:3b'
}

# Chuỗi YAML trong nháy đơn: đường dẫn Windows không phải escape dấu \.
function ConvertTo-AgYamlString {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function New-AgMachineYaml {
  param($Plan)
  return @(
    '# Slot dùng chung cho mọi worker trên máy này (install.ps1 tạo; -ReconfigureSlots để tính lại)',
    "cpu_slots: $($Plan.cpu_slots)",
    "gpu_slots: $($Plan.gpu_slots)",
    'reserve_interactive:',
    "  cpu: $($Plan.reserve_cpu)",
    "  gpu: $($Plan.reserve_gpu)"
  ) -join "`r`n"
}

function New-AgConfigYaml {
  param([string]$Hub, $Node, [string]$RoleDir, [string]$CacheDir, [int]$CacheGb, [string]$MachineFile, [hashtable]$Extra)
  $lines = @(
    '# Cấu hình worker (install.ps1 tạo). Token chỉ hiện ở đây, đừng chia sẻ file này.',
    "hub_url: $(ConvertTo-AgYamlString $Hub)",
    "token: $(ConvertTo-AgYamlString $Node.token)",
    "name: $(ConvertTo-AgYamlString $Node.name)",
    'kinds:'
  )
  foreach ($k in $Node.kinds) { $lines += "  - $k" }
  $lines += "work_dir: $(ConvertTo-AgYamlString (Join-Path $RoleDir 'work'))"
  $lines += 'cache:'
  $lines += "  dir: $(ConvertTo-AgYamlString $CacheDir)"
  $lines += "  max_gb: $CacheGb"
  $lines += "machine_file: $(ConvertTo-AgYamlString $MachineFile)"
  if ($Extra -and $Extra.Count -gt 0) {
    $lines += 'extra:'
    foreach ($key in ($Extra.Keys | Sort-Object)) {
      $v = $Extra[$key]
      if ($v -is [bool]) { $lines += "  ${key}: $($v.ToString().ToLower())" }
      else { $lines += "  ${key}: $(ConvertTo-AgYamlString ([string]$v))" }
    }
  }
  return $lines -join "`r`n"
}

# Đọc một khoá chuỗi trong config.yaml đã có (token, name, hub_url) khi cập nhật không kèm mã.
function Read-AgConfigValue {
  param([string]$Path, [string]$Key)
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match "^${Key}:\s*'(.*)'\s*$") { return ($Matches[1] -replace "''", "'") }
    if ($line -match "^${Key}:\s*(\S.*?)\s*$") { return $Matches[1] }
  }
  return $null
}

function Invoke-AgApi {
  param([string]$Method, [string]$Url, $Body, [string]$Token)
  $headers = @{}
  if ($Token) { $headers['Authorization'] = "Node $Token" }
  $params = @{ Method = $Method; Uri = $Url; Headers = $headers; UseBasicParsing = $true; ContentType = 'application/json; charset=utf-8' }
  if ($null -ne $Body) { $params['Body'] = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8 -Compress)) }
  $res = Invoke-RestMethod @params
  # Hub bọc mọi câu trả lời trong { data, success, ... }
  if ($res -and ($res.PSObject.Properties.Name -contains 'success') -and ($res.PSObject.Properties.Name -contains 'data')) { return $res.data }
  return $res
}

function Test-AgAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Confirm-AgStep {
  param([string]$Question, [switch]$Yes)
  if ($Yes) { return $true }
  $answer = Read-Host "$Question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes|c|co)$')
}

function Stop-AgRole {
  param([string]$TaskName, [string]$AppDir)
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # Dừng task không giết tiến trình con: tìm node.exe của thư mục này
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($AppDir) }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Bản cũ cài bằng NSSM (deploy\install-windows.ps1): gỡ dịch vụ để không chạy hai worker.
function Remove-AgLegacyService {
  param([string]$Name)
  & sc.exe query $Name *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Gỡ dịch vụ cũ $Name (NSSM)"
    & sc.exe stop $Name *> $null
    Start-Sleep -Seconds 3
    & sc.exe delete $Name *> $null
  }
}

function Register-AgTask {
  param([string]$TaskName, [string]$CmdPath, [string]$WorkDir, [int]$Priority)
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$CmdPath`"" -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Priority $Priority
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

function Find-AgOllama {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  )
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  return $null
}

function Wait-AgHttp {
  param([string]$Url, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 | Out-Null; return $true } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

# Ollama chạy như task hệ thống (không cần ai đăng nhập). Thư mục model dùng chung cả máy.
function Install-AgOllama {
  param([string]$InstallDir, [string]$Model, [switch]$Yes)
  $exe = Find-AgOllama
  if (-not $exe) {
    if (-not (Confirm-AgStep 'Máy chưa có Ollama (cần cho quét video). Cài Ollama bản chính thức?' -Yes:$Yes)) {
      throw 'Cần Ollama cho vai trò quét. Cài từ https://ollama.com/download rồi chạy lại lệnh.'
    }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      & $winget.Source install -e --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements
    } else {
      $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
      Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
      Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait
    }
    $exe = Find-AgOllama
    if (-not $exe) { throw 'Cài Ollama xong nhưng không tìm thấy ollama.exe. Mở PowerShell mới rồi chạy lại lệnh.' }
  }

  # Dùng lại model đã tải của người đang cài nếu có, khỏi tải lại vài GB.
  $userModels = Join-Path $env:USERPROFILE '.ollama\models'
  if (Test-Path -LiteralPath (Join-Path $userModels 'manifests')) { $modelsDir = $userModels }
  else { $modelsDir = Join-Path $InstallDir 'ollama\models' }
  New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
  [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $modelsDir, 'Machine')

  $ollamaDir = Join-Path $InstallDir 'ollama'
  New-Item -ItemType Directory -Force -Path $ollamaDir | Out-Null
  $serveCmd = Join-Path $ollamaDir 'ollama-serve.cmd'
  $cmdText = @(
    '@echo off',
    'rem Ollama cho ag-scan-worker, chạy bằng task ag-farm-ollama (install.ps1 tạo)',
    "set OLLAMA_MODELS=$modelsDir",
    'set OLLAMA_HOST=127.0.0.1:11434',
    ':loop',
    "`"$exe`" serve >> `"$ollamaDir\ollama.log`" 2>&1",
    'ping -n 11 127.0.0.1 >nul',
    'goto loop'
  ) -join "`r`n"
  [IO.File]::WriteAllText($serveCmd, $cmdText, (New-Object Text.UTF8Encoding($false)))

  # Ollama khay hệ thống của người dùng đang giữ cổng 11434 với thư mục model khác: dừng để task lấy cổng.
  Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Stop-AgRole -TaskName 'ag-farm-ollama' -AppDir $ollamaDir
  Register-AgTask -TaskName 'ag-farm-ollama' -CmdPath $serveCmd -WorkDir $ollamaDir -Priority 6
  if (-not (Wait-AgHttp -Url 'http://127.0.0.1:11434/api/version' -Seconds 60)) {
    throw "Ollama không lên sau 60 giây. Xem $ollamaDir\ollama.log"
  }

  Write-Host "Tải model $Model (lần đầu có thể mất vài phút)"
  $env:OLLAMA_HOST = '127.0.0.1:11434'
  & $exe pull $Model
  if ($LASTEXITCODE -ne 0) { throw "ollama pull $Model lỗi" }
}

function Install-AgPackage {
  param([string]$Hub, $Latest, [string]$PackageName, [string]$RoleDir)
  $info = $Latest.packages.$PackageName
  if (-not $info) { throw "Hub chưa có gói $PackageName (thiếu trong /dist/latest.json)" }
  $zip = Join-Path $env:TEMP $info.file
  Write-Host "Tải $($info.file) ($([Math]::Round($info.size_bytes / 1MB)) MB)"
  Invoke-WebRequest -Uri "$Hub/dist/$($info.file)" -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($hash -ne $info.sha256) { throw "Gói $($info.file) tải về bị hỏng (sha256 không khớp)" }

  $staging = Join-Path $RoleDir 'staging'
  Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
  $inner = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
  $appDir = Join-Path $RoleDir 'app'
  Remove-Item -Recurse -Force -LiteralPath $appDir -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $inner.FullName -Destination $appDir
  Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  Remove-Item -Force -LiteralPath $zip -ErrorAction SilentlyContinue
  return $info.version
}

function Wait-AgOnline {
  param([string]$Hub, [string]$Token, [string]$Name, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $me = Invoke-AgApi -Method Get -Url "$Hub/v1/worker/me" -Token $Token
      if ($me.last_seen_at -and ((Get-Date) - [datetime]$me.last_seen_at).TotalSeconds -lt 120) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Install-AgWorker {
  param(
    [Parameter(Mandatory = $true)][string]$Hub,
    [string]$Code,
    [string]$InstallDir = 'C:\ag-farm',
    [string]$Model,
    [switch]$WithTts,
    [switch]$ReconfigureSlots,
    [switch]$Yes
  )
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $ProgressPreference = 'SilentlyContinue'  # thanh tiến độ của iwr làm tải chậm hàng chục lần trên PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Hub = $Hub.TrimEnd('/')

  if (-not (Test-AgAdmin)) { throw 'Hãy mở PowerShell bằng "Run as Administrator" rồi chạy lại lệnh.' }

  $machineInfo = Get-AgMachineInfo
  $gpuText = ($machineInfo.gpus | ForEach-Object { "$($_.name) $([Math]::Round($_.vram_mb / 1024)) GB" }) -join ', '
  if (-not $gpuText) { $gpuText = 'không có GPU NVIDIA' }
  Write-Host "Máy: $($machineInfo.cpu_cores) luồng CPU, $([Math]::Round($machineInfo.ram_mb / 1024)) GB RAM, $gpuText"

  $drive = (Split-Path -Qualifier $InstallDir).TrimEnd(':')
  $free = (Get-PSDrive -Name $drive).Free
  if ($free -lt 20GB) { throw "Ổ $drive còn $([Math]::Round($free / 1GB)) GB, cần ít nhất 20 GB" }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

  # 1. Vai trò và token: mã mới (cài / cài lại) hoặc config đã có (cập nhật)
  $roles = @()
  $nodes = @{}
  if ($Code) {
    $body = [ordered]@{ code = $Code; os = 'windows'; cpu_cores = $machineInfo.cpu_cores; ram_mb = $machineInfo.ram_mb; gpus = @($machineInfo.gpus) }
    $enrolled = Invoke-AgApi -Method Post -Url "$Hub/v1/enroll" -Body $body
    foreach ($n in $enrolled.nodes) { $roles += $n.role; $nodes[$n.role] = $n }
    Write-Host "Đã đăng ký máy $($enrolled.machine): $(($enrolled.nodes | ForEach-Object { $_.name }) -join ', ')"
  } else {
    foreach ($r in @('scan', 'render')) {
      $cfg = Join-Path $InstallDir "$r\config.yaml"
      if (Test-Path -LiteralPath $cfg) {
        $roles += $r
        $nodes[$r] = [pscustomobject]@{ role = $r; name = (Read-AgConfigValue $cfg 'name'); token = (Read-AgConfigValue $cfg 'token'); kinds = @() }
      }
    }
    if ($roles.Count -eq 0) { throw 'Máy chưa cài worker: cần -Code (lấy ở trang Máy của web farm).' }
    Write-Host "Cập nhật vai trò: $($roles -join ', ')"
  }

  # 2. Slot dùng chung của máy
  $machineFile = 'C:\ProgramData\ag-farm\machine.yaml'
  if ($ReconfigureSlots -or -not (Test-Path -LiteralPath $machineFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $machineFile) | Out-Null
    $plan = Get-AgSlotPlan -Cores $machineInfo.cpu_cores -Gpus $machineInfo.gpus -Roles $roles
    [IO.File]::WriteAllText($machineFile, (New-AgMachineYaml $plan), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Slot: $($plan.cpu_slots) CPU, $($plan.gpu_slots) GPU (giữ $($plan.reserve_cpu) CPU cho render)"
  }

  # 3. Worker chạy tay từ trước (ngoài thư mục cài) sẽ tranh việc với bản mới
  $strays = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'worker\.mjs' -and -not $_.CommandLine.Contains($InstallDir) }
  if ($strays -and (Confirm-AgStep "Có $(@($strays).Count) worker khác đang chạy ngoài $InstallDir. Dừng chúng?" -Yes:$Yes)) {
    foreach ($p in $strays) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  $latest = Invoke-AgApi -Method Get -Url "$Hub/dist/latest.json"
  if ($latest -is [string]) { $latest = $latest | ConvertFrom-Json }
  $cacheGb = [int][Math]::Max(10, [Math]::Min(200, [Math]::Floor($free / 1GB * 0.25)))

  foreach ($role in $roles) {
    $node = $nodes[$role]
    $package = @{ scan = 'ag-scan-worker'; render = 'ag-render-worker' }[$role]
    $roleDir = Join-Path $InstallDir $role
    $taskName = "ag-farm-$role"
    New-Item -ItemType Directory -Force -Path $roleDir | Out-Null

    Remove-AgLegacyService -Name $package
    Stop-AgRole -TaskName $taskName -AppDir (Join-Path $roleDir 'app')
    $version = Install-AgPackage -Hub $Hub -Latest $latest -PackageName $package -RoleDir $roleDir
    Write-Host "$package $version đã cài vào $roleDir\app"

    $extra = @{}
    if ($role -eq 'scan') {
      $extra['ollama_url'] = 'http://127.0.0.1:11434'
      if (-not $Model) { $Model = Get-AgDefaultModel -Gpus $machineInfo.gpus }
      Install-AgOllama -InstallDir $InstallDir -Model $Model -Yes:$Yes
    } else {
      $extra['encoder'] = 'auto'
      $extra['ollama_url'] = 'http://127.0.0.1:11434'
      $extra['unload_ollama_before_tts'] = $true
      if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR 'Fonts\arial.ttf'))) { Write-Warning 'Không thấy font Arial: job render có chữ sẽ lỗi fonts_missing' }
      if ($WithTts) {
        $venv = Join-Path $InstallDir 'venv'
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $roleDir 'app\deploy\setup-python.ps1') -Venv $venv
        $extra['python_bin'] = Join-Path $venv 'Scripts\python.exe'
      }
    }

    $configPath = Join-Path $roleDir 'config.yaml'
    if ($Code) {
      $yaml = New-AgConfigYaml -Hub $Hub -Node $node -RoleDir $roleDir -CacheDir (Join-Path $InstallDir "cache\$role") -CacheGb $cacheGb -MachineFile $machineFile -Extra $extra
      [IO.File]::WriteAllText($configPath, $yaml, (New-Object Text.UTF8Encoding($false)))
    }

    # Render ưu tiên thường; quét dưới mức thường (worker quét còn tự hạ thêm).
    $priority = 7
    if ($role -eq 'render') { $priority = 4 }
    Register-AgTask -TaskName $taskName -CmdPath (Join-Path $roleDir 'app\run.cmd') -WorkDir (Join-Path $roleDir 'app') -Priority $priority
  }

  # 4. Chờ hub thấy từng máy
  $allOnline = $true
  foreach ($role in $roles) {
    $node = $nodes[$role]
    if (Wait-AgOnline -Hub $Hub -Token $node.token -Name $node.name -Seconds 120) {
      Write-Host "$($node.name): Online" -ForegroundColor Green
    } else {
      $allOnline = $false
      Write-Warning "$($node.name) chưa gửi heartbeat sau 2 phút. Xem log: $InstallDir\$role\logs\worker.log"
    }
  }
  if ($allOnline) { Write-Host 'Xong. Máy tự chạy lại worker khi khởi động hoặc khi worker lỗi.' -ForegroundColor Green }
}
