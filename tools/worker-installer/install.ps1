# ag-farm: cài hoặc cập nhật máy worker (quét / render) trên Windows, một lệnh.
#
# Mở PowerShell bằng "Run as Administrator" rồi dán lệnh lấy ở trang Máy của web farm:
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm> -Code <mã>
# Cập nhật lên bản mới (không cần mã; config.yaml giữ name, token, cache và khoá tự thêm, viết lại các khoá extra
# installer quản lý, bỏ danh sách kinds khi gói mới tự tính được; bản trước lưu ở config.yaml.bak):
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm>
# Chạy từ file tải về:
#   iex (Get-Content -Raw -Encoding UTF8 .\install.ps1); Install-AgWorker -Hub ... -Code ...
#
# Tuỳ chọn:
#   -InstallDir C:\ag-farm   thư mục cài (mặc định C:\ag-farm)
#   -Model qwen2.5vl:7b      model Ollama cho máy quét (mặc định: danh sách hub cấu hình FARM_OLLAMA_MODELS)
#   -ReconfigureSlots        tính lại machine.yaml theo cấu hình máy
#   -SkipModels              máy render: không tải trước model giọng đọc / nhận dạng lời nói (tải ở job đầu)
#   -Yes                     không hỏi (cài Ollama, dừng worker cũ)
#   -WithTts                 bỏ, không còn tác dụng (máy render luôn tự cài những gì nó cần, theo GPU của máy)
#
# Script làm: đổi mã lấy token trên hub, tải gói mới nhất, tự tính số slot, cài Ollama + model (máy quét),
# chạy deploy\setup-render.ps1 của gói (máy render: Python 3.11, venv, yt-dlp, torch CUDA + OmniVoice + WhisperX và
# model khi có GPU NVIDIA; log ở <InstallDir>\logs\setup.log), chạy mỗi vai trò thành một task hệ thống (tự chạy khi
# bật máy, tự chạy lại khi chết), chờ máy Online.

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
# GPU: số card NVIDIA có >= 3,5 GB (qwen2.5vl:3b chạy được trên card 4 GB). Máy có vai trò render thì giữ 1 slot CPU cho render; GPU không giữ riêng
# (máy 1 GPU sẽ không quét được) mà job quét nhường GPU khi render cần.
function Get-AgSlotPlan {
  param([int]$Cores, [object[]]$Gpus, [string[]]$Roles)
  $cpu = [Math]::Max(1, [Math]::Min(6, [Math]::Floor($Cores / 6)))
  $gpu = @($Gpus | Where-Object { $_.vram_mb -ge 3500 }).Count
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
    '# Slot dung chung cho moi worker tren may nay (install.ps1 tao; -ReconfigureSlots de tinh lai)',
    "cpu_slots: $($Plan.cpu_slots)",
    "gpu_slots: $($Plan.gpu_slots)",
    'reserve_interactive:',
    "  cpu: $($Plan.reserve_cpu)",
    "  gpu: $($Plan.reserve_gpu)"
  ) -join "`r`n"
}

function ConvertTo-AgYamlValue {
  param($Value)
  if ($Value -is [bool]) { return $Value.ToString().ToLower() }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return [string]$Value }
  return ConvertTo-AgYamlString ([string]$Value)
}

# Chia config.yaml thành các khối cấp cao: dòng `khoá:` ở cột 0 mở khối; dòng thụt vào và dòng trống thuộc khối phía
# trên; comment ở cột 0 thuộc khối ngay sau nó (bỏ khối thì bỏ cả comment của khối). Khối đầu (key $null) là phần mở đầu.
function Split-AgYamlBlocks {
  param([string]$Text)
  $blocks = New-Object System.Collections.ArrayList
  $current = [pscustomobject]@{ key = $null; lines = (New-Object System.Collections.ArrayList) }
  [void]$blocks.Add($current)
  $pending = New-Object System.Collections.ArrayList
  if ($Text) {
    foreach ($line in ($Text -split "`r?`n")) {
      if ($line -match '^([A-Za-z_][A-Za-z0-9_-]*)\s*:') {
        $current = [pscustomobject]@{ key = $Matches[1]; lines = (New-Object System.Collections.ArrayList) }
        foreach ($p in $pending) { [void]$current.lines.Add($p) }
        $pending.Clear()
        [void]$current.lines.Add($line)
        [void]$blocks.Add($current)
      } elseif ($line -match '^#') {
        [void]$pending.Add($line)
      } else {
        foreach ($p in $pending) { [void]$current.lines.Add($p) }
        $pending.Clear()
        [void]$current.lines.Add($line)
      }
    }
  }
  foreach ($p in $pending) { [void]$current.lines.Add($p) }
  return , $blocks
}

# Ghi các khoá `$Managed` vào khối `extra:` (mảng dòng, kể cả dòng `extra:`), giữ nguyên khoá người dùng tự thêm.
# Giá trị $null: giữ như cũ. Trả về mảng dòng mới.
function Merge-AgYamlExtra {
  param([string[]]$Lines, [System.Collections.IDictionary]$Managed)
  $headerAt = -1
  for ($i = 0; $i -lt $Lines.Count; $i++) { if ($Lines[$i] -match '^extra\s*:') { $headerAt = $i; break } }
  $out = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $headerAt; $i++) { [void]$out.Add($Lines[$i]) }
  $inline = ''
  if ($headerAt -ge 0 -and $Lines[$headerAt] -match '^extra\s*:\s*(.*?)\s*$') { $inline = $Matches[1] }
  if ($inline -and $inline -ne '{}' -and -not $inline.StartsWith('#')) {
    Write-Warning "config.yaml: khong sua duoc 'extra: $inline' (viet dang khoi nhieu dong de installer ghi lai)"
    return , [string[]]$Lines
  }
  [void]$out.Add('extra:')

  # Các mục con: dòng `<thụt>khoá:` cùng độ thụt với mục đầu tiên mở một mục; dòng comment/trống ngay trước thuộc
  # mục đó (`lead`), dòng thụt sâu hơn thuộc mục phía trên.
  $entries = New-Object System.Collections.ArrayList
  $pending = New-Object System.Collections.ArrayList
  $indent = $null
  $entry = $null
  for ($i = $headerAt + 1; $i -lt $Lines.Count; $i++) {
    $line = $Lines[$i]
    if ($line -match '^(\s+)([A-Za-z_][A-Za-z0-9_-]*)\s*:' -and ($null -eq $indent -or $Matches[1] -eq $indent)) {
      if ($null -eq $indent) { $indent = $Matches[1] }
      $entry = [pscustomobject]@{ key = $Matches[2]; lead = @($pending); lines = (New-Object System.Collections.ArrayList) }
      $pending.Clear()
      [void]$entry.lines.Add($line)
      [void]$entries.Add($entry)
    } elseif ($line -match '^\s*(#|$)') {
      [void]$pending.Add($line)
    } elseif ($entry) {
      foreach ($p in $pending) { [void]$entry.lines.Add($p) }
      $pending.Clear()
      [void]$entry.lines.Add($line)
    } else { [void]$pending.Add($line) }
  }
  if ($null -eq $indent) { $indent = '  ' }

  $done = @{}
  foreach ($e in $entries) {
    if ($Managed.Contains($e.key) -and $null -ne $Managed[$e.key]) {
      $e.lines.Clear()
      [void]$e.lines.Add("$indent$($e.key): $(ConvertTo-AgYamlValue $Managed[$e.key])")
      $done[$e.key] = $true
    }
  }
  $added = @()
  foreach ($key in $Managed.Keys) {
    if (-not $done.ContainsKey($key) -and $null -ne $Managed[$key]) { $added += "$indent${key}: $(ConvertTo-AgYamlValue $Managed[$key])" }
  }

  $body = New-Object System.Collections.ArrayList
  foreach ($e in $entries) { foreach ($l in (@($e.lead) + @($e.lines))) { [void]$body.Add($l) } }
  foreach ($p in $pending) { [void]$body.Add($p) }
  # Khoá mới đặt sau dòng có nội dung cuối cùng (dòng trống cuối khối giữ ở cuối)
  $lastContent = $body.Count - 1
  while ($lastContent -ge 0 -and -not "$($body[$lastContent])".Trim()) { $lastContent-- }
  for ($i = 0; $i -le $lastContent; $i++) { [void]$out.Add($body[$i]) }
  foreach ($l in $added) { [void]$out.Add($l) }
  for ($i = $lastContent + 1; $i -lt $body.Count; $i++) { [void]$out.Add($body[$i]) }
  return , [string[]]$out
}

# Thêm khối mới vào cuối; dòng trống cuối khối đang đứng cuối được bỏ để khối mới không bị tách xa.
function Add-AgYamlBlock {
  param([System.Collections.ArrayList]$Blocks, [string]$Key, [string[]]$Lines)
  if ($Blocks.Count -gt 0) {
    $last = $Blocks[$Blocks.Count - 1].lines
    while ($last.Count -gt 0 -and -not "$($last[$last.Count - 1])".Trim()) { $last.RemoveAt($last.Count - 1) }
  }
  [void]$Blocks.Add([pscustomobject]@{ key = $Key; lines = [System.Collections.ArrayList]@($Lines) })
}

# Viết config.yaml của một vai trò. Cài mới (`$Existing` rỗng) hay cập nhật đều qua đây:
#   - giữ mọi khoá đang có (name, token, hub_url, cache, schedule, khoá người dùng tự thêm, khoá extra lạ);
#   - `-Enrolled` (vừa đổi mã): ghi đè hub_url, token, name bằng node mới;
#   - khoá còn thiếu (work_dir, cache, machine_file) thì thêm;
#   - `extra`: viết lại các khoá installer quản lý ($Extra, giá trị $null = giữ như cũ);
#   - `-OmitKinds`: bỏ danh sách `kinds` (worker tự tính loại job theo handler và máy); không thì ghi `Node.kinds`
#     nếu có, giữ danh sách cũ nếu không.
function New-AgConfigYaml {
  param(
    [string]$Hub, $Node, [string]$RoleDir, [string]$CacheDir, [int]$CacheGb, [string]$MachineFile,
    [System.Collections.IDictionary]$Extra, [string]$Existing = '', [switch]$Enrolled, [switch]$OmitKinds
  )
  $blocks = Split-AgYamlBlocks $Existing
  $fresh = -not ($blocks | Where-Object { $_.key })
  if ($fresh) {
    $blocks[0].lines.Clear()
    [void]$blocks[0].lines.Add('# Cau hinh worker (install.ps1 tao). Token chi hien o day, dung chia se file nay.')
    [void]$blocks[0].lines.Add('# Moi lan cap nhat, install.ps1 giu cac khoa dang co va viet lai cac khoa no quan ly trong extra')
    [void]$blocks[0].lines.Add('# (python_bin, ytdlp_bin, hf_home, encoder, ollama_url, ...). Khong khai kinds: worker tu nhan moi loai job no chay duoc.')
  }

  $set = [ordered]@{}
  $defaults = [ordered]@{
    hub_url = @("hub_url: $(ConvertTo-AgYamlString $Hub)")
    token = @("token: $(ConvertTo-AgYamlString $Node.token)")
    name = @("name: $(ConvertTo-AgYamlString $Node.name)")
  }
  if ($Enrolled) { $set = $defaults; $defaults = [ordered]@{} }
  $remove = @()
  if ($OmitKinds) { $remove += 'kinds' }
  elseif (@($Node.kinds).Count -gt 0) { $set['kinds'] = @('kinds:') + @($Node.kinds | ForEach-Object { "  - $_" }) }
  $defaults['work_dir'] = @("work_dir: $(ConvertTo-AgYamlString (Join-Path $RoleDir 'work'))")
  $defaults['cache'] = @('cache:', "  dir: $(ConvertTo-AgYamlString $CacheDir)", "  max_gb: $CacheGb")
  $defaults['machine_file'] = @("machine_file: $(ConvertTo-AgYamlString $MachineFile)")

  $result = New-Object System.Collections.ArrayList
  foreach ($b in $blocks) { if (-not $b.key -or $remove -notcontains $b.key) { [void]$result.Add($b) } }
  foreach ($key in $set.Keys) {
    $b = $result | Where-Object { $_.key -eq $key } | Select-Object -First 1
    if ($b) {
      # Giữ comment ngay trên khoá, thay phần còn lại
      $keep = @()
      for ($i = 0; $i -lt $b.lines.Count -and $b.lines[$i] -notmatch "^${key}\s*:"; $i++) { $keep += $b.lines[$i] }
      $b.lines.Clear()
      foreach ($l in $keep) { [void]$b.lines.Add($l) }
      foreach ($l in $set[$key]) { [void]$b.lines.Add($l) }
    } else {
      Add-AgYamlBlock $result $key $set[$key]
    }
  }
  foreach ($key in $defaults.Keys) {
    if (-not ($result | Where-Object { $_.key -eq $key })) {
      Add-AgYamlBlock $result $key $defaults[$key]
    }
  }
  if ($Extra -and $Extra.Count -gt 0) {
    $b = $result | Where-Object { $_.key -eq 'extra' } | Select-Object -First 1
    if ($b) {
      $merged = Merge-AgYamlExtra -Lines ([string[]]@($b.lines)) -Managed $Extra
      $b.lines.Clear()
      foreach ($l in $merged) { [void]$b.lines.Add($l) }
    } elseif (@($Extra.Values | Where-Object { $null -ne $_ }).Count -gt 0) {
      $merged = Merge-AgYamlExtra -Lines @('extra:') -Managed $Extra
      Add-AgYamlBlock $result 'extra' $merged
    }
  }

  $lines = @()
  foreach ($b in $result) { $lines += @($b.lines) }
  while ($lines.Count -gt 0 -and -not "$($lines[$lines.Count - 1])".Trim()) { $lines = @($lines | Select-Object -First ($lines.Count - 1)) }
  return $lines -join "`r`n"
}

# Gói worker từ bản này trở đi đọc được config không có `kinds` (worker-sdk tự tính loại job). Gói cũ hơn bắt buộc có.
$AgKindsOptionalSince = @{ 'ag-render-worker' = '0.9.0'; 'ag-scan-worker' = '0.4.0' }

function Test-AgKindsOptional {
  param([string]$Package, [string]$Version)
  $since = $AgKindsOptionalSince[$Package]
  if (-not $since -or -not $Version) { return $false }
  $v = $null
  if (-not [version]::TryParse(($Version -replace '[-+].*$', ''), [ref]$v)) { return $false }
  return $v -ge [version]$since
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
    Write-Host "Go dich vu cu $Name (NSSM)"
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
  param([string]$InstallDir, [string[]]$Models, [switch]$Yes)
  $exe = Find-AgOllama
  if (-not $exe) {
    if (-not (Confirm-AgStep 'May chua co Ollama (can cho quet video). Cai Ollama ban chinh thuc?' -Yes:$Yes)) {
      throw 'Can Ollama cho vai tro quet. Cai tu https://ollama.com/download roi chay lai lenh.'
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
    if (-not $exe) { throw 'Cai Ollama xong nhung khong tim thay ollama.exe. Mo PowerShell moi roi chay lai lenh.' }
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
    'rem Ollama cho ag-scan-worker, chay bang task ag-farm-ollama (install.ps1 tao)',
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
    throw "Ollama khong len sau 60 giay. Xem $ollamaDir\ollama.log"
  }

  $env:OLLAMA_HOST = '127.0.0.1:11434'
  foreach ($m in $Models) {
    Write-Host "Tai model $m (lan dau co the mat vai phut)"
    & $exe pull $m
    if ($LASTEXITCODE -ne 0) { throw "ollama pull $m loi" }
  }
}

function Install-AgPackage {
  param([string]$Hub, $Latest, [string]$PackageName, [string]$RoleDir)
  $info = $Latest.packages.$PackageName
  if (-not $info) { throw "Hub chua co goi $PackageName (thieu trong /dist/latest.json)" }
  $zip = Join-Path $env:TEMP $info.file
  Write-Host "Tai $($info.file) ($([Math]::Round($info.size_bytes / 1MB)) MB)"
  Invoke-WebRequest -Uri "$Hub/dist/$($info.file)" -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($hash -ne $info.sha256) { throw "Goi $($info.file) tai ve bi hong (sha256 khong khop)" }

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

# Chạy deploy\setup-render.ps1 của gói vừa cài (cả lúc cài lẫn lúc cập nhật; bước nào đã xong thì nó bỏ qua) và đọc
# kết quả JSON của nó: { ok, python_bin, ytdlp_bin, hf_home, gpu, torch, cuda, errors[] }. $null nếu gói cũ không có.
function Invoke-AgRenderSetup {
  param([string]$AppDir, [string]$InstallDir, [switch]$SkipModels)
  $setup = Join-Path $AppDir 'deploy\setup-render.ps1'
  if (-not (Test-Path -LiteralPath $setup)) { return $null }
  $resultFile = Join-Path $InstallDir 'logs\setup-result.json'
  Remove-Item -Force -LiteralPath $resultFile -ErrorAction SilentlyContinue
  Write-Host 'Cai Python, yt-dlp va (may co GPU NVIDIA) torch, OmniVoice, WhisperX, model. Lan dau co the mat 10-30 phut.'
  $setupArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setup, '-InstallDir', $InstallDir, '-ResultFile', $resultFile)
  if ($SkipModels) { $setupArgs += '-SkipModels' }
  & powershell @setupArgs
  if (-not (Test-Path -LiteralPath $resultFile)) {
    Write-Warning "setup-render.ps1 khong ghi ket qua. Xem $InstallDir\logs\setup.log"
    return [pscustomobject]@{ ok = $false; python_bin = $null; ytdlp_bin = $null; hf_home = $null; errors = @('setup-render.ps1 khong ghi ket qua') }
  }
  $r = Get-Content -Raw -Encoding UTF8 -LiteralPath $resultFile | ConvertFrom-Json
  foreach ($e in @($r.errors)) { if ($e) { Write-Warning $e } }
  if (-not $r.ok) { Write-Warning "Cai dat may render chua tron ven. Xem $InstallDir\logs\setup.log, sua xong chay lai lenh cap nhat." }
  return $r
}

# Các khoá `extra` installer quản lý cho máy render. Khoá setup không xác định được (lỗi, gói cũ) là $null: giữ giá trị cũ.
function Get-AgRenderExtra {
  param($SetupResult)
  $extra = [ordered]@{
    encoder = 'auto'
    ollama_url = 'http://127.0.0.1:11434'
    unload_ollama_before_tts = $true
    python_bin = $null
    ytdlp_bin = $null
    hf_home = $null
  }
  if ($SetupResult) {
    if ($SetupResult.python_bin) { $extra['python_bin'] = [string]$SetupResult.python_bin }
    if ($SetupResult.ytdlp_bin) { $extra['ytdlp_bin'] = [string]$SetupResult.ytdlp_bin }
    if ($SetupResult.hf_home) { $extra['hf_home'] = [string]$SetupResult.hf_home }
  }
  return $extra
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
    # Bỏ: máy render luôn chạy setup-render.ps1. Vẫn nhận để lệnh cũ không lỗi.
    [switch]$WithTts,
    [switch]$ReconfigureSlots,
    [switch]$SkipModels,
    [switch]$Yes
  )
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $ProgressPreference = 'SilentlyContinue'  # thanh tien do cua iwr lam tai cham hang chuc lan tren PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Hub = $Hub.TrimEnd('/')

  if (-not (Test-AgAdmin)) { throw 'Hay mo PowerShell bang "Run as Administrator" roi chay lai lenh.' }

  $machineInfo = Get-AgMachineInfo
  $gpuText = ($machineInfo.gpus | ForEach-Object { "$($_.name) $([Math]::Round($_.vram_mb / 1024)) GB" }) -join ', '
  if (-not $gpuText) { $gpuText = 'khong co GPU NVIDIA' }
  Write-Host "May: $($machineInfo.cpu_cores) luong CPU, $([Math]::Round($machineInfo.ram_mb / 1024)) GB RAM, $gpuText"

  $drive = (Split-Path -Qualifier $InstallDir).TrimEnd(':')
  $free = (Get-PSDrive -Name $drive).Free
  if ($free -lt 20GB) { throw "O $drive con $([Math]::Round($free / 1GB)) GB, can it nhat 20 GB" }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

  # 1. Vai trò và token: mã mới (cài / cài lại) hoặc config đã có (cập nhật)
  $roles = @()
  $nodes = @{}
  $hubModels = @()
  if ($Code) {
    $body = [ordered]@{ code = $Code; os = 'windows'; cpu_cores = $machineInfo.cpu_cores; ram_mb = $machineInfo.ram_mb; gpus = @($machineInfo.gpus) }
    $enrolled = Invoke-AgApi -Method Post -Url "$Hub/v1/enroll" -Body $body
    foreach ($n in $enrolled.nodes) { $roles += $n.role; $nodes[$n.role] = $n }
    $hubModels = @($enrolled.ollama_models)
    Write-Host "Da dang ky may $($enrolled.machine): $(($enrolled.nodes | ForEach-Object { $_.name }) -join ', ')"
  } else {
    foreach ($r in @('scan', 'render')) {
      $cfg = Join-Path $InstallDir "$r\config.yaml"
      if (Test-Path -LiteralPath $cfg) {
        $roles += $r
        $nodes[$r] = [pscustomobject]@{ role = $r; name = (Read-AgConfigValue $cfg 'name'); token = (Read-AgConfigValue $cfg 'token'); kinds = @() }
      }
    }
    if ($roles.Count -eq 0) { throw 'May chua cai worker: can -Code (lay o trang May cua web farm).' }
    try { $hubModels = @((Invoke-AgApi -Method Get -Url "$Hub/v1/worker/me" -Token $nodes[$roles[0]].token).ollama_models) } catch { }
    Write-Host "Cap nhat vai tro: $($roles -join ', ')"
  }

  # 2. Slot dùng chung của máy
  $machineFile = 'C:\ProgramData\ag-farm\machine.yaml'
  if ($ReconfigureSlots -or -not (Test-Path -LiteralPath $machineFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $machineFile) | Out-Null
    $plan = Get-AgSlotPlan -Cores $machineInfo.cpu_cores -Gpus $machineInfo.gpus -Roles $roles
    [IO.File]::WriteAllText($machineFile, (New-AgMachineYaml $plan), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Slot: $($plan.cpu_slots) CPU, $($plan.gpu_slots) GPU (giu $($plan.reserve_cpu) CPU cho render)"
  }

  # 3. Worker chạy tay từ trước (ngoài thư mục cài) sẽ tranh việc với bản mới
  $strays = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'worker\.mjs' -and -not $_.CommandLine.Contains($InstallDir) }
  if ($strays -and (Confirm-AgStep "Co $(@($strays).Count) worker khac dang chay ngoai $InstallDir. Dung cac worker do?" -Yes:$Yes)) {
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
    Write-Host "$package $version da cai vao $roleDir\app"

    # Khoá extra installer quản lý (cài lẫn cập nhật đều ghi lại); khoá khác trong extra là của người dùng, giữ nguyên.
    $extra = [ordered]@{}
    if ($role -eq 'scan') {
      $extra['ollama_url'] = 'http://127.0.0.1:11434'
      # Model phải trùng model chủ job gửi trong job (hub cấu hình); chỉ đoán theo VRAM khi hub không nói.
      if ($Model) { $models = @($Model) }
      elseif ($hubModels.Count -gt 0) { $models = $hubModels }
      else { $models = @(Get-AgDefaultModel -Gpus $machineInfo.gpus) }
      Install-AgOllama -InstallDir $InstallDir -Models $models -Yes:$Yes
    } else {
      if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR 'Fonts\arial.ttf'))) { Write-Warning 'Khong thay font Arial: job render co chu se loi fonts_missing' }
      $setupResult = Invoke-AgRenderSetup -AppDir (Join-Path $roleDir 'app') -InstallDir $InstallDir -SkipModels:$SkipModels
      if (-not $setupResult) { Write-Warning "Goi $package $version chua co deploy\setup-render.ps1: khong cai Python/yt-dlp" }
      $renderExtra = Get-AgRenderExtra -SetupResult $setupResult
      foreach ($k in $renderExtra.Keys) { if ($null -ne $renderExtra[$k]) { $extra[$k] = $renderExtra[$k] } }
    }

    # Cài và cập nhật đều ghi lại config: giữ name, token, cache, khoá người dùng thêm; viết lại khoá extra quản lý;
    # gói mới thì bỏ `kinds` (worker tự nhận mọi loại job nó chạy được), gói cũ vẫn cần danh sách đó.
    $configPath = Join-Path $roleDir 'config.yaml'
    $existing = ''
    if (Test-Path -LiteralPath $configPath) {
      $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath
      Copy-Item -Force -LiteralPath $configPath -Destination "$configPath.bak"
    }
    $yaml = New-AgConfigYaml -Hub $Hub -Node $node -RoleDir $roleDir -CacheDir (Join-Path $InstallDir "cache\$role") -CacheGb $cacheGb `
      -MachineFile $machineFile -Extra $extra -Existing $existing -Enrolled:([bool]$Code) -OmitKinds:(Test-AgKindsOptional -Package $package -Version $version)
    [IO.File]::WriteAllText($configPath, $yaml, (New-Object Text.UTF8Encoding($false)))

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
      Write-Warning "$($node.name) chua gui heartbeat sau 2 phut. Xem log: $InstallDir\$role\logs\worker.log"
    }
  }
  if ($allOnline) { Write-Host 'Xong. May tu chay lai worker khi khoi dong hoac khi worker loi.' -ForegroundColor Green }
}
