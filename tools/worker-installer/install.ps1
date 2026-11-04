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
# Chuyển máy đã cài sang ổ / thư mục khác (giữ token, config, venv, model, log; xem Move-AgWorker):
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Move-AgWorker -To D:\ag-farm
#
# Tuỳ chọn:
#   -InstallDir D:\ag-farm   thư mục cài. Bỏ trống: chỗ máy đã cài (registry HKLM\SOFTWARE\ag-farm, task ag-farm-*),
#                            chưa cài thì C:\ag-farm. Cập nhật / gỡ không cần truyền lại.
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
#
# Tự cập nhật: script lưu một bản của chính nó vào <InstallDir>\updater\ và tạo task ag-farm-updater (SYSTEM). Worker
# (render 0.9.0 / scan 0.4.0 trở lên) thấy bản mới trong /dist/latest.json thì ngừng nhận việc, chờ việc đang chạy xong,
# ghi updater\request-<vai trò>.json rồi chạy task; task cũng chạy mỗi đêm 03:00 (dự phòng). Task cài bản mới như lệnh
# cập nhật ở trên (giữ bản cũ ở <vai trò>\app.prev); bản mới không gửi heartbeat trong 3 phút thì quay về app.prev.
# Kết quả ghi ở updater\result-<vai trò>.json (worker báo lên hub), log ở updater\updater.log.
# Máy đang chạy render 0.8.1 / scan 0.3.5 trở về trước: chạy lệnh cập nhật ở trên một lần cuối bằng tay.
#
# Trang trên máy: config mỗi vai trò có `local_ui.port` (scan 47811, render 47812); worker có trang này mở
# http://127.0.0.1:<port> (chỉ máy đó) để xem việc đang chạy và log. Script tạo shortcut "ag-farm" trên Desktop chung
# khi trang đã chạy.

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
#   - `-UpdaterDir`: thêm các khoá tự cập nhật còn thiếu (updater_task, updater_dir, update_check_minutes,
#     update_drain_minutes); khoá đã có (người dùng sửa số phút) giữ nguyên.
#   - `-LocalUiPort`: thêm `local_ui.port` nếu thiếu (trang xem việc và log trên máy); đã có (kể cả `local_ui: false`)
#     thì giữ nguyên.
function New-AgConfigYaml {
  param(
    [string]$Hub, $Node, [string]$RoleDir, [string]$CacheDir, [int]$CacheGb, [string]$MachineFile,
    [System.Collections.IDictionary]$Extra, [string]$Existing = '', [switch]$Enrolled, [switch]$OmitKinds,
    [string]$UpdaterDir, [int]$LocalUiPort
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
  if ($UpdaterDir) {
    $defaults['updater_task'] = @('# Tu cap nhat: worker chay task nay khi hub co ban moi (chi worker render 0.9.0 / scan 0.4.0 tro len)', "updater_task: $(ConvertTo-AgYamlString $AgUpdaterTask)")
    $defaults['updater_dir'] = @("updater_dir: $(ConvertTo-AgYamlString $UpdaterDir)")
    $defaults['update_check_minutes'] = @('update_check_minutes: 15')
    $defaults['update_drain_minutes'] = @('# Co ban moi: cho viec dang chay xong toi da chung nay phut roi cap nhat', 'update_drain_minutes: 30')
  }
  if ($LocalUiPort -gt 0) {
    $defaults['local_ui'] = @("# Trang xem viec dang chay va log tren may nay: http://127.0.0.1:$LocalUiPort (chi may nay mo duoc)", 'local_ui:', "  port: $LocalUiPort")
  }

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

# Task Windows chạy bộ cập nhật (worker xin cập nhật, và mỗi đêm làm dự phòng).
$AgUpdaterTask = 'ag-farm-updater'
# Slot dùng chung cho mọi worker trên máy (test đổi sang thư mục tạm).
$AgMachineFile = 'C:\ProgramData\ag-farm\machine.yaml'
$AgRolePackages = [ordered]@{ scan = 'ag-scan-worker'; render = 'ag-render-worker' }
# Thư mục cài khi máy chưa cài ở đâu; đã cài thì Find-AgInstallDir tìm lại.
$AgDefaultInstallDir = 'C:\ag-farm'
# install.ps1 ghi thư mục cài ở đây để cập nhật, gỡ, chuyển ổ không phải truyền lại -InstallDir.
$AgRegistryKey = 'HKLM:\SOFTWARE\ag-farm'
# Trang xem việc và log trên máy (worker-sdk `local_ui`): mỗi vai trò một cổng, chỉ nghe 127.0.0.1.
$AgLocalUiPorts = [ordered]@{ scan = 47811; render = 47812 }

# Thư mục cài suy từ đối số của task worker (`/c "D:\ag-farm\render\app\run.cmd"`), $null nếu không khớp.
function Get-AgInstallDirFromTaskArgs {
  param([string]$Arguments)
  if ("$Arguments" -match '([A-Za-z]:\\[^"]*?)\\(scan|render)\\app\\run\.cmd') { return $Matches[1] }
  return $null
}

# Thư mục máy này đã cài worker: khoá registry install.ps1 ghi, không có (cài bằng bản cũ) thì đọc từ task
# ag-farm-scan / ag-farm-render. $null nếu chưa cài.
function Find-AgInstallDir {
  try {
    $dir = (Get-ItemProperty -Path $AgRegistryKey -Name InstallDir -ErrorAction Stop).InstallDir
    if ($dir -and (Test-Path -LiteralPath $dir)) { return $dir }
  } catch { }
  foreach ($role in $AgRolePackages.Keys) {
    $task = Get-ScheduledTask -TaskName "ag-farm-$role" -ErrorAction SilentlyContinue
    foreach ($a in @($task.Actions)) {
      $dir = Get-AgInstallDirFromTaskArgs $a.Arguments
      if ($dir -and (Test-Path -LiteralPath $dir)) { return $dir }
    }
  }
  return $null
}

function Set-AgInstallDirRecord {
  param([string]$InstallDir)
  if (-not (Test-Path -LiteralPath $AgRegistryKey)) { New-Item -Path $AgRegistryKey | Out-Null }
  Set-ItemProperty -Path $AgRegistryKey -Name InstallDir -Value $InstallDir
}

# Kiểm và chuẩn hoá thư mục cài: đường dẫn đầy đủ có ổ đĩa và ít nhất một thư mục (D:\ag-farm), bỏ \ cuối.
function ConvertTo-AgInstallDir {
  param([string]$Path)
  $p = "$Path".Trim().TrimEnd('\')
  if ($p -notmatch '^[A-Za-z]:\\[^"*?<>|:]+$') { throw "Thu muc cai '$Path' khong hop le: can duong dan day du, vd D:\ag-farm" }
  return $p
}

# Hai đường dẫn cùng một thư mục (không phân biệt hoa thường, bỏ \ cuối).
function Test-AgSamePath {
  param([string]$A, [string]$B)
  return "$A".TrimEnd('\') -ieq "$B".TrimEnd('\')
}

# $Path nằm trong thư mục $Dir (hoặc chính nó).
function Test-AgPathUnder {
  param([string]$Path, [string]$Dir)
  return "$($Path.TrimEnd('\'))\".StartsWith("$($Dir.TrimEnd('\'))\", [StringComparison]::OrdinalIgnoreCase)
}

# Render ưu tiên thường; quét dưới mức thường (worker quét còn tự hạ thêm).
function Get-AgRolePriority {
  param([string]$Role)
  if ($Role -eq 'render') { return 4 }
  return 7
}

# So hai phiên bản kiểu semver (1.2.3, 1.2.3-rc.1): âm nếu $A cũ hơn $B, 0 nếu bằng, dương nếu mới hơn. Bản -rc đứng
# trước bản chính cùng số. Chuỗi không đọc được coi như cũ hơn mọi bản đọc được.
function Compare-AgVersion {
  param([string]$A, [string]$B)
  $re = '^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$'
  $ma = [regex]::Match("$A".Trim(), $re)
  $mb = [regex]::Match("$B".Trim(), $re)
  if (-not $ma.Success -or -not $mb.Success) {
    if ($ma.Success) { return 1 }
    if ($mb.Success) { return -1 }
    return 0
  }
  for ($i = 1; $i -le 3; $i++) {
    $d = [long]$ma.Groups[$i].Value - [long]$mb.Groups[$i].Value
    if ($d -ne 0) { return [Math]::Sign($d) }
  }
  $pa = $ma.Groups[4].Value
  $pb = $mb.Groups[4].Value
  if (-not $pa -and -not $pb) { return 0 }
  if (-not $pa) { return 1 }
  if (-not $pb) { return -1 }
  $xa = $pa.Split('.')
  $xb = $pb.Split('.')
  for ($i = 0; $i -lt [Math]::Max($xa.Count, $xb.Count); $i++) {
    if ($i -ge $xa.Count) { return -1 }
    if ($i -ge $xb.Count) { return 1 }
    $na = $xa[$i] -match '^\d+$'
    $nb = $xb[$i] -match '^\d+$'
    if ($na -and $nb) {
      $d = [long]$xa[$i] - [long]$xb[$i]
      if ($d -ne 0) { return [Math]::Sign($d) }
    } elseif ($na) { return -1 }
    elseif ($nb) { return 1 }
    else {
      $c = [string]::CompareOrdinal($xa[$i], $xb[$i])
      if ($c -ne 0) { return [Math]::Sign($c) }
    }
  }
  return 0
}

# Phiên bản gói đang cài trong <vai trò>\app (package.json), $null nếu chưa có.
function Get-AgInstalledVersion {
  param([string]$AppDir)
  $pkg = Join-Path $AppDir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { return $null }
  try { return [string](Get-Content -Raw -Encoding UTF8 -LiteralPath $pkg | ConvertFrom-Json).version } catch { return $null }
}

# Ghi JSON qua file tạm rồi đổi tên (worker không bao giờ đọc nửa file). UTF-8 không BOM.
function Write-AgJsonFile {
  param([string]$Path, $Object)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $tmp = "$Path.tmp"
  [IO.File]::WriteAllText($tmp, ($Object | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Move-Item -Force -LiteralPath $tmp -Destination $Path
}

function Read-AgJsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path) | ConvertFrom-Json } catch { return $null }
}

# Kết quả một lần cài/cập nhật của một vai trò, worker đọc lúc khởi động và báo hub: { state: done|failed, ... }.
function Write-AgUpdateResult {
  param([string]$UpdaterDir, [string]$Role, [string]$State, [string]$From, [string]$Target, [string]$Message, [string]$RequestedAt)
  $result = [ordered]@{ state = $State; from_version = $From; target_version = $Target; finished_at = (Get-Date).ToUniversalTime().ToString('o') }
  if ($Message) { $result['message'] = $Message.Substring(0, [Math]::Min(480, $Message.Length)) }
  if ($RequestedAt) { $result['requested_at'] = $RequestedAt }
  Write-AgJsonFile -Path (Join-Path $UpdaterDir "result-$Role.json") -Object $result
}

# Dòng có nội dung cuối cùng của một file log (vd. setup.log), $null nếu không có.
function Get-AgLastLine {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $lines = @(Get-Content -LiteralPath $Path -Tail 20 -Encoding UTF8 | Where-Object { "$_".Trim() })
  if ($lines.Count -eq 0) { return $null }
  return "$($lines[$lines.Count - 1])".Trim()
}

# Chọn vai trò cần cập nhật (hàm thuần, test được):
#   $Installed:  vai trò -> phiên bản đang cài;  $Latest: nội dung latest.json;
#   $Requests:   vai trò -> yêu cầu worker ghi (request-<vai trò>.json);
#   $AutoUpdate: vai trò -> auto_update hub trả ($null = không hỏi được: coi như cho phép);
#   $LastResults: vai trò -> result-<vai trò>.json lần trước.
# Chỉ cập nhật khi hub có bản mới hơn bản đang cài. Worker xin thì làm (worker đã hỏi hub). Không ai xin (chạy đêm):
# chỉ khi hub cho tự cập nhật và bản đó chưa từng hỏng trên máy này.
function Select-AgUpdateRoles {
  param([hashtable]$Installed, $Latest, [hashtable]$Requests, [hashtable]$AutoUpdate, [hashtable]$LastResults)
  $out = @()
  foreach ($role in $Installed.Keys) {
    $package = $AgRolePackages[$role]
    if (-not $package -or -not $Latest -or -not $Latest.packages) { continue }
    $info = $Latest.packages.$package
    if (-not $info -or -not $info.version) { continue }
    if ((Compare-AgVersion $info.version $Installed[$role]) -le 0) { continue }
    if ($Requests -and $Requests.ContainsKey($role)) { $out += $role; continue }
    if ($AutoUpdate -and $AutoUpdate.ContainsKey($role) -and $AutoUpdate[$role] -eq $false) { continue }
    $last = $null
    if ($LastResults) { $last = $LastResults[$role] }
    if ($last -and $last.state -eq 'failed' -and $last.target_version -eq $info.version) { continue }
    $out += $role
  }
  return , @($out | Sort-Object { @($AgRolePackages.Keys).IndexOf($_) })
}

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

  # Model nằm trong thư mục cài (ổ người cài chọn). Người cài đã có model (~\.ollama\models) thì khỏi tải lại vài GB:
  # cài ở ổ hệ thống thì dùng luôn thư mục đó, cài ở ổ khác thì chép sang (một lần, khi chỗ mới chưa có model).
  $userModels = Join-Path $env:USERPROFILE '.ollama\models'
  $modelsDir = Join-Path $InstallDir 'ollama\models'
  if (Test-Path -LiteralPath (Join-Path $userModels 'manifests')) {
    if ((Split-Path -Qualifier $InstallDir) -ieq $env:SystemDrive) { $modelsDir = $userModels }
    elseif (-not (Test-Path -LiteralPath (Join-Path $modelsDir 'manifests'))) {
      Write-Host "Chep model Ollama tu $userModels sang $modelsDir"
      Copy-AgTree -From $userModels -To $modelsDir
    }
  }
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
  # Tải vào <InstallDir>\tmp (ổ cài), không vào TEMP trên ổ C
  $tmpDir = Join-Path (Split-Path -Parent $RoleDir) 'tmp'
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $zip = Join-Path $tmpDir $info.file
  Write-Host "Tai $($info.file) ($([Math]::Round($info.size_bytes / 1MB)) MB)"
  Invoke-WebRequest -Uri "$Hub/dist/$($info.file)" -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($hash -ne $info.sha256) { throw "Goi $($info.file) tai ve bi hong (sha256 khong khop)" }
  Install-AgPackageZip -Zip $zip -RoleDir $RoleDir
  Remove-Item -Force -LiteralPath $zip -ErrorAction SilentlyContinue
  return $info.version
}

# Giải nén gói vào <vai trò>\staging rồi thay app: bản đang chạy giữ ở app.prev (bản app.prev cũ hơn bị xoá) để
# quay về được nếu bản mới không chạy.
function Install-AgPackageZip {
  param([string]$Zip, [string]$RoleDir)
  $staging = Join-Path $RoleDir 'staging'
  Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $Zip -DestinationPath $staging -Force
  $inner = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
  if (-not $inner) { throw "Goi $Zip khong co thu muc ung dung" }
  $appDir = Join-Path $RoleDir 'app'
  $prevDir = Join-Path $RoleDir 'app.prev'
  if (Test-Path -LiteralPath $appDir) {
    Remove-Item -Recurse -Force -LiteralPath $prevDir -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $appDir -Destination $prevDir
  }
  Move-Item -LiteralPath $inner.FullName -Destination $appDir
  Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
}

# Quay về bản trước: app.prev thành app (bản hỏng bị xoá); -RestoreConfig thì config.yaml.bak thành config.yaml.
# Trả $false nếu không có app.prev.
function Restore-AgAppDir {
  param([string]$RoleDir, [switch]$RestoreConfig)
  $appDir = Join-Path $RoleDir 'app'
  $prevDir = Join-Path $RoleDir 'app.prev'
  if (-not (Test-Path -LiteralPath $prevDir)) { return $false }
  Remove-Item -Recurse -Force -LiteralPath $appDir -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $prevDir -Destination $appDir
  $configPath = Join-Path $RoleDir 'config.yaml'
  if ($RestoreConfig -and (Test-Path -LiteralPath "$configPath.bak")) { Copy-Item -Force -LiteralPath "$configPath.bak" -Destination $configPath }
  return $true
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

# Hub thấy node gửi heartbeat trong 2 phút gần đây (-Since: và sau mốc đó, vd. lúc worker ở chỗ mới khởi động).
function Wait-AgOnline {
  param([string]$Hub, [string]$Token, [string]$Name, [int]$Seconds, [datetime]$Since = [datetime]::MinValue)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $me = Invoke-AgApi -Method Get -Url "$Hub/v1/worker/me" -Token $Token
      if ($me.last_seen_at -and ((Get-Date) - [datetime]$me.last_seen_at).TotalSeconds -lt 120 -and [datetime]$me.last_seen_at -gt $Since) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

# Bản vừa cài đã chạy: hub thấy node báo đúng phiên bản này trong 2 phút gần đây.
function Wait-AgVersion {
  param([string]$Hub, [string]$Token, [string]$Version, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $me = Invoke-AgApi -Method Get -Url "$Hub/v1/worker/me" -Token $Token
      if ($me.agent_version -eq $Version -and $me.last_seen_at -and ((Get-Date) - [datetime]$me.last_seen_at).TotalSeconds -lt 120) { return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  return $false
}

# Lưu bộ cập nhật vào <InstallDir>\updater: bản install.ps1 mới nhất của hub (lần cập nhật sau dùng đúng installer của
# hub lúc đó) và update.ps1 mà task ag-farm-updater chạy. Tải hỏng thì giữ bản đang có.
function Save-AgUpdater {
  param([string]$Hub, [string]$InstallDir)
  $dir = Join-Path $InstallDir 'updater'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir 'install.ps1'
  $tmp = Join-Path $dir 'install.ps1.download'
  try {
    Invoke-WebRequest -Uri "$Hub/dist/install.ps1" -OutFile $tmp -UseBasicParsing
    $text = [IO.File]::ReadAllText($tmp, (New-Object Text.UTF8Encoding($false)))
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0 -or $text -notmatch 'function Invoke-AgAutoUpdate') { throw 'install.ps1 tren hub khong dung duoc' }
    # BOM: PowerShell 5.1 đọc file .ps1 không BOM theo bảng mã ANSI.
    [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($true)))
  } catch {
    Write-Warning "Khong luu duoc bo cap nhat moi ($($_.Exception.Message)); giu ban dang co"
  } finally {
    Remove-Item -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
  [IO.File]::WriteAllText((Join-Path $dir 'update.ps1'), (New-AgUpdaterScript -InstallDir $InstallDir), (New-Object Text.UTF8Encoding($true)))
  return $dir
}

# Nội dung updater\update.ps1: nạp bản install.ps1 lưu cạnh nó rồi chạy Invoke-AgAutoUpdate.
function New-AgUpdaterScript {
  param([string]$InstallDir)
  return @(
    '# ag-farm: bo cap nhat worker (install.ps1 tao). Task ag-farm-updater (SYSTEM) chay file nay khi worker xin cap nhat',
    "# va moi dem luc 03:00. Log: $(Join-Path $InstallDir 'updater\updater.log')",
    '$ErrorActionPreference = ''Stop''',
    '. (Join-Path $PSScriptRoot ''install.ps1'')',
    "Invoke-AgAutoUpdate -InstallDir $(ConvertTo-AgYamlString $InstallDir)"
  ) -join "`r`n"
}

# Task ag-farm-updater: SYSTEM, worker chạy khi xin cập nhật (schtasks /Run), và mỗi đêm 03:00 làm dự phòng.
function Register-AgUpdaterTask {
  param([string]$InstallDir)
  $script = Join-Path $InstallDir 'updater\update.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Join-Path $InstallDir 'updater')
  $trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $AgUpdaterTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

# Điểm vào của task ag-farm-updater. Đọc yêu cầu worker ghi (updater\request-<vai trò>.json), chọn vai trò cần cập
# nhật (Select-AgUpdateRoles) rồi cài như lệnh cập nhật, không hỏi gì (-Auto: giữ app.prev, kiểm bản mới gửi heartbeat
# trong 3 phút, không thì quay về). Worker khác xin trong lúc đang cài thì làm tiếp vòng sau.
function Invoke-AgAutoUpdate {
  param([string]$InstallDir = 'C:\ag-farm')
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $dir = Join-Path $InstallDir 'updater'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $log = Join-Path $dir 'updater.log'
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -Force -LiteralPath $log -Destination "$log.1" }
  try { Start-Transcript -Path $log -Append | Out-Null } catch { }
  try {
    for ($round = 0; $round -lt 5; $round++) {
      $installed = @{}
      $tokens = @{}
      $hub = $null
      foreach ($role in $AgRolePackages.Keys) {
        $cfg = Join-Path $InstallDir "$role\config.yaml"
        if (-not (Test-Path -LiteralPath $cfg)) { continue }
        $installed[$role] = Get-AgInstalledVersion (Join-Path $InstallDir "$role\app")
        $tokens[$role] = Read-AgConfigValue $cfg 'token'
        if (-not $hub) { $hub = Read-AgConfigValue $cfg 'hub_url' }
      }
      if ($installed.Count -eq 0 -or -not $hub) { Write-Host 'Chua cai worker nao: khong co gi de cap nhat'; return }
      $hub = $hub.TrimEnd('/')

      $requests = @{}
      foreach ($role in @($installed.Keys)) {
        $path = Join-Path $dir "request-$role.json"
        $req = Read-AgJsonFile $path
        Remove-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue
        if ($req) { $requests[$role] = $req }
      }
      if ($round -gt 0 -and $requests.Count -eq 0) { return }

      $latest = Invoke-AgApi -Method Get -Url "$hub/dist/latest.json"
      if ($latest -is [string]) { $latest = $latest | ConvertFrom-Json }
      $auto = @{}
      $last = @{}
      foreach ($role in @($installed.Keys)) {
        $last[$role] = Read-AgJsonFile (Join-Path $dir "result-$role.json")
        if (-not $requests.ContainsKey($role)) {
          try { $auto[$role] = (Invoke-AgApi -Method Get -Url "$hub/v1/worker/me" -Token $tokens[$role]).auto_update } catch { $auto[$role] = $null }
        }
      }
      $roles = Select-AgUpdateRoles -Installed $installed -Latest $latest -Requests $requests -AutoUpdate $auto -LastResults $last
      foreach ($role in $requests.Keys) {
        if ($roles -notcontains $role) {
          Write-Host "$role`: worker xin cap nhat nhung hub khong co ban moi hon $($installed[$role])"
          Write-AgUpdateResult -UpdaterDir $dir -Role $role -State 'done' -From $installed[$role] -Target $installed[$role] `
            -Message "Already on the latest version ($($installed[$role]))" -RequestedAt $requests[$role].requested_at
        }
      }
      if ($roles.Count -eq 0) { Write-Host 'Khong co ban moi'; if ($requests.Count -eq 0) { return } else { continue } }
      Write-Host "$(Get-Date -Format o) Cap nhat: $($roles -join ', ')"
      try {
        Install-AgWorker -Hub $hub -InstallDir $InstallDir -OnlyRoles $roles -Auto -Yes -UpdateRequests $requests
      } catch {
        # Lỗi trước khi đụng tới vai trò nào (ổ đầy, hub không trả latest.json...): ghi lỗi cho từng vai trò.
        $msg = "Update failed before installing: $($_.Exception.Message)"
        Write-Warning $msg
        foreach ($role in $roles) {
          $target = $latest.packages.($AgRolePackages[$role]).version
          $requestedAt = $null
          if ($requests.ContainsKey($role)) { $requestedAt = $requests[$role].requested_at }
          Write-AgUpdateResult -UpdaterDir $dir -Role $role -State 'failed' -From $installed[$role] -Target $target -Message $msg -RequestedAt $requestedAt
          Start-ScheduledTask -TaskName "ag-farm-$role" -ErrorAction SilentlyContinue
        }
      }
    }
  } finally {
    try { Stop-Transcript | Out-Null } catch { }
  }
}

function Install-AgWorker {
  param(
    [Parameter(Mandatory = $true)][string]$Hub,
    [string]$Code,
    # Bỏ trống: chỗ máy đã cài (Find-AgInstallDir), chưa cài thì C:\ag-farm.
    [string]$InstallDir,
    [string]$Model,
    # Bỏ: máy render luôn chạy setup-render.ps1. Vẫn nhận để lệnh cũ không lỗi.
    [switch]$WithTts,
    [switch]$ReconfigureSlots,
    [switch]$SkipModels,
    [switch]$Yes,
    # Chỉ cập nhật các vai trò này (mặc định: mọi vai trò đã cài). Bộ cập nhật dùng.
    [string[]]$OnlyRoles,
    # Bộ cập nhật (ag-farm-updater) gọi: không đụng worker ngoài thư mục cài, mỗi vai trò kiểm bản mới gửi heartbeat
    # trong 3 phút, lỗi thì quay về app.prev và ghi kết quả thay vì dừng cả lệnh.
    [switch]$Auto,
    # Yêu cầu worker ghi (vai trò -> request): kết quả ghi lại requested_at của yêu cầu đã xử lý.
    [hashtable]$UpdateRequests = @{}
  )
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $ProgressPreference = 'SilentlyContinue'  # thanh tien do cua iwr lam tai cham hang chuc lan tren PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Hub = $Hub.TrimEnd('/')

  if (-not (Test-AgAdmin)) { throw 'Hay mo PowerShell bang "Run as Administrator" roi chay lai lenh.' }

  # Thư mục cài: bộ cập nhật luôn truyền; cài / cập nhật tay không truyền thì dùng chỗ máy đã cài.
  $installedAt = $null
  if (-not $Auto) { $installedAt = Find-AgInstallDir }
  if (-not $InstallDir) {
    if ($installedAt) { $InstallDir = $installedAt } else { $InstallDir = $AgDefaultInstallDir }
  }
  $InstallDir = ConvertTo-AgInstallDir $InstallDir
  if ($installedAt -and -not (Test-AgSamePath $installedAt $InstallDir)) {
    Write-Warning "May dang cai worker o $installedAt. Cai vao $InstallDir thi thu muc cu khong dung nua (muon mang theo venv, model, log thi dung: Move-AgWorker -To $InstallDir)."
    if (-not (Confirm-AgStep "Van cai vao $InstallDir?" -Yes:$Yes)) { throw 'Da huy' }
  }
  Write-Host "Thu muc cai: $InstallDir"

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
    if ($OnlyRoles) { $roles = @($roles | Where-Object { $OnlyRoles -contains $_ }) }
    if ($roles.Count -eq 0) { throw "May chua cai vai tro $($OnlyRoles -join ', ')" }
    try { $hubModels = @((Invoke-AgApi -Method Get -Url "$Hub/v1/worker/me" -Token $nodes[$roles[0]].token).ollama_models) } catch { }
    Write-Host "Cap nhat vai tro: $($roles -join ', ')"
  }

  # 2. Slot dùng chung của máy
  $machineFile = $AgMachineFile
  if ($ReconfigureSlots -or -not (Test-Path -LiteralPath $machineFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $machineFile) | Out-Null
    $plan = Get-AgSlotPlan -Cores $machineInfo.cpu_cores -Gpus $machineInfo.gpus -Roles $roles
    [IO.File]::WriteAllText($machineFile, (New-AgMachineYaml $plan), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Slot: $($plan.cpu_slots) CPU, $($plan.gpu_slots) GPU (giu $($plan.reserve_cpu) CPU cho render)"
  }

  # 3. Worker chạy tay từ trước (ngoài thư mục cài) sẽ tranh việc với bản mới
  $strays = $null
  if (-not $Auto) {
    $strays = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'worker\.mjs' -and -not $_.CommandLine.Contains($InstallDir) }
  }
  if ($strays -and (Confirm-AgStep "Co $(@($strays).Count) worker khac dang chay ngoai $InstallDir. Dung cac worker do?" -Yes:$Yes)) {
    foreach ($p in $strays) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  $latest = Invoke-AgApi -Method Get -Url "$Hub/dist/latest.json"
  if ($latest -is [string]) { $latest = $latest | ConvertFrom-Json }
  $cacheGb = [int][Math]::Max(10, [Math]::Min(200, [Math]::Floor($free / 1GB * 0.25)))

  $updaterDir = Join-Path $InstallDir 'updater'
  foreach ($role in $roles) {
    $node = $nodes[$role]
    $package = $AgRolePackages[$role]
    $roleDir = Join-Path $InstallDir $role
    $taskName = "ag-farm-$role"
    New-Item -ItemType Directory -Force -Path $roleDir | Out-Null
    $fromVersion = Get-AgInstalledVersion (Join-Path $roleDir 'app')
    $targetVersion = $latest.packages.$package.version
    $requestedAt = $null
    if ($UpdateRequests.ContainsKey($role)) { $requestedAt = [string]$UpdateRequests[$role].requested_at }
    $swapped = $false
    $configWritten = $false
    $setupNote = $null

    try {
      Remove-AgLegacyService -Name $package
      Stop-AgRole -TaskName $taskName -AppDir (Join-Path $roleDir 'app')
      $version = Install-AgPackage -Hub $Hub -Latest $latest -PackageName $package -RoleDir $roleDir
      $swapped = $true
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
        elseif (-not $setupResult.ok) {
          $setupNote = "setup: $((@($setupResult.errors) | Where-Object { $_ }) -join '; ')"
          $lastLine = Get-AgLastLine (Join-Path $InstallDir 'logs\setup.log')
          if ($lastLine) { $setupNote += " | setup.log: $lastLine" }
        }
        $renderExtra = Get-AgRenderExtra -SetupResult $setupResult
        foreach ($k in $renderExtra.Keys) { if ($null -ne $renderExtra[$k]) { $extra[$k] = $renderExtra[$k] } }
      }

      # Cài và cập nhật đều ghi lại config: giữ name, token, cache, khoá người dùng thêm; viết lại khoá extra quản lý;
      # gói mới thì bỏ `kinds` (worker tự nhận mọi loại job nó chạy được), gói cũ vẫn cần danh sách đó; thêm khoá
      # tự cập nhật còn thiếu.
      $configPath = Join-Path $roleDir 'config.yaml'
      $existing = ''
      if (Test-Path -LiteralPath $configPath) {
        $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath
        Copy-Item -Force -LiteralPath $configPath -Destination "$configPath.bak"
      }
      $yaml = New-AgConfigYaml -Hub $Hub -Node $node -RoleDir $roleDir -CacheDir (Join-Path $InstallDir "cache\$role") -CacheGb $cacheGb `
        -MachineFile $machineFile -Extra $extra -Existing $existing -Enrolled:([bool]$Code) -OmitKinds:(Test-AgKindsOptional -Package $package -Version $version) `
        -UpdaterDir $updaterDir -LocalUiPort $AgLocalUiPorts[$role]
      [IO.File]::WriteAllText($configPath, $yaml, (New-Object Text.UTF8Encoding($false)))
      $configWritten = $true

      Register-AgTask -TaskName $taskName -CmdPath (Join-Path $roleDir 'app\run.cmd') -WorkDir (Join-Path $roleDir 'app') -Priority (Get-AgRolePriority $role)

      # Bộ cập nhật: bản mới phải gửi heartbeat (đúng phiên bản) trong 3 phút, không thì quay về bản cũ.
      if ($Auto -and -not (Wait-AgVersion -Hub $Hub -Token $node.token -Version $version -Seconds 180)) {
        throw "$package $version did not send a heartbeat within 3 minutes (see $roleDir\logs\worker.log)"
      }
      $doneMessage = "Updated from $fromVersion to $version"
      if (-not $fromVersion) { $doneMessage = "Installed $version" }
      if ($setupNote) { $doneMessage += " ($setupNote)" }
      Write-AgUpdateResult -UpdaterDir $updaterDir -Role $role -State 'done' -From $fromVersion -Target $version -Message $doneMessage -RequestedAt $requestedAt
    } catch {
      if (-not $Auto) { throw }
      $msg = "$($_.Exception.Message)"
      if ($setupNote) { $msg += " ($setupNote)" }
      Write-Warning "$role`: cap nhat loi: $msg"
      Stop-AgRole -TaskName $taskName -AppDir (Join-Path $roleDir 'app')
      if ($swapped) {
        if (Restore-AgAppDir -RoleDir $roleDir -RestoreConfig:$configWritten) { $msg += "; rolled back to $fromVersion" }
        else { $msg += '; no previous version to roll back to' }
      }
      try { Start-ScheduledTask -TaskName $taskName } catch { $msg += "; could not restart $taskName" }
      Write-AgUpdateResult -UpdaterDir $updaterDir -Role $role -State 'failed' -From $fromVersion -Target $targetVersion -Message $msg -RequestedAt $requestedAt
    }
  }

  try { Set-AgInstallDirRecord $InstallDir } catch { Write-Warning "Khong ghi duoc thu muc cai vao registry ($($_.Exception.Message))" }

  # Bộ cập nhật: lưu bản installer mới nhất của hub cho lần sau; cài/cập nhật tay thì (đăng ký lại) task ag-farm-updater.
  try {
    Save-AgUpdater -Hub $Hub -InstallDir $InstallDir | Out-Null
    if (-not $Auto) { Register-AgUpdaterTask -InstallDir $InstallDir }
  } catch {
    Write-Warning "Chua cai duoc bo tu cap nhat ($($_.Exception.Message)): may van chay, cap nhat bang lenh tay"
  }
  if ($Auto) {
    Update-AgShortcut -InstallDir $InstallDir -Seconds 20 | Out-Null
    return
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
  $page = Update-AgShortcut -InstallDir $InstallDir -Seconds 30
  if ($page) { Write-Host "Xem viec dang chay va log tren may nay: $page (shortcut ag-farm tren Desktop)" }
  if ($allOnline) { Write-Host 'Xong. May tu chay lai worker khi khoi dong hoac khi worker loi, va tu cap nhat khi hub co ban moi.' -ForegroundColor Green }
}

# Shortcut "ag-farm" trên Desktop chung, mở trang xem việc và log của worker (render trước, không có thì scan). Chỉ tạo
# khi trang đã trả lời (gói cũ chưa có trang thì thôi, shortcut đang có giữ nguyên). Trả địa chỉ trang, $null nếu không có.
function Update-AgShortcut {
  param([string]$InstallDir, [int]$Seconds)
  $urls = @(@('render', 'scan') | Where-Object { Test-Path -LiteralPath (Join-Path $InstallDir "$_\config.yaml") } |
    ForEach-Object { "http://127.0.0.1:$($AgLocalUiPorts[$_])/" })
  if ($urls.Count -eq 0) { return $null }
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    foreach ($url in $urls) {
      try { Invoke-WebRequest -Uri "${url}api/status" -UseBasicParsing -TimeoutSec 3 | Out-Null } catch { continue }
      try {
        $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
        [IO.File]::WriteAllText((Join-Path $desktop 'ag-farm.url'), "[InternetShortcut]`r`nURL=$url`r`n", [Text.Encoding]::ASCII)
      } catch {
        Write-Warning "Khong tao duoc shortcut tren Desktop ($($_.Exception.Message))"
      }
      return $url
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
}

# ---- Chuyển thư mục cài (Move-AgWorker) ----

# Chép cây thư mục bằng robocopy (giữ giờ, thử lại khi file bận), bỏ các thư mục $Exclude (đường dẫn đầy đủ).
function Copy-AgTree {
  param([string]$From, [string]$To, [string[]]$Exclude = @())
  $rcArgs = @($From, $To, '/E', '/COPY:DAT', '/DCOPY:T', '/R:2', '/W:2', '/MT:8', '/NP', '/NFL', '/NDL')
  if ($Exclude.Count -gt 0) { $rcArgs += '/XD'; $rcArgs += $Exclude }
  & robocopy.exe @rcArgs | Out-Host
  # robocopy: 0-7 là xong (1 = có chép), từ 8 là lỗi
  if ($LASTEXITCODE -ge 8) { throw "robocopy loi (ma $LASTEXITCODE) khi chep $From sang $To" }
}

# Tổng dung lượng file trong $Path, bỏ các thư mục $Exclude.
function Get-AgDirSize {
  param([string]$Path, [string[]]$Exclude = @())
  $files = Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $f = $_.FullName; -not ($Exclude | Where-Object { Test-AgPathUnder $f $_ }) }
  return [long](($files | Measure-Object -Property Length -Sum).Sum)
}

# Thư mục không cần chép khi chuyển: việc dở (work), gói đang giải nén (staging), file tải tạm (tmp); cache tải lại được
# nên chỉ chép khi -CopyCache.
function Get-AgMoveExcludes {
  param([string]$From, [string[]]$Roles, [switch]$CopyCache)
  $out = @(Join-Path $From 'tmp')
  foreach ($role in $Roles) { $out += (Join-Path $From "$role\work"); $out += (Join-Path $From "$role\staging") }
  if (-not $CopyCache) { $out += (Join-Path $From 'cache') }
  return , $out
}

# Đổi đường dẫn nằm trong thư mục cài cũ sang thư mục mới (config.yaml: work_dir, cache.dir, updater_dir, extra...).
# Chỉ đổi đúng thư mục đó: chuyển C:\ag-farm không đụng C:\ag-farm2.
function Convert-AgConfigPaths {
  param([string]$Text, [string]$From, [string]$To)
  $pattern = [regex]::Escape($From.TrimEnd('\')) + '(?=\\|''|"|\s|$)'
  $options = [Text.RegularExpressions.RegexOptions]'IgnoreCase, Multiline'
  return [regex]::Replace($Text, $pattern, $To.TrimEnd('\').Replace('$', '$$'), $options)
}

# Dừng mọi thứ của một thư mục cài: các task ag-farm-*, tiến trình chạy từ thư mục đó (node, cmd, python của venv,
# ffmpeg...) và Ollama.
function Stop-AgInstall {
  param([string]$InstallDir)
  foreach ($task in @($AgUpdaterTask, 'ag-farm-scan', 'ag-farm-render', 'ag-farm-ollama')) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue }
  }
  $needle = "$($InstallDir.TrimEnd('\'))\"
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
      "$($_.CommandLine)".IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      "$($_.ExecutablePath)".IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

# venv chép sang chỗ mới: python.exe vẫn chạy (pyvenv.cfg trỏ Python gốc), nhưng các .exe trong Scripts (yt-dlp.exe)
# ghi cứng python của venv cũ. Cài lại yt-dlp (không đụng gói khác) để pip viết lại launcher.
function Repair-AgVenvLaunchers {
  param([string]$InstallDir)
  $py = Join-Path $InstallDir 'venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $py)) { return }
  Write-Host 'Viet lai yt-dlp.exe cho venv o cho moi'
  & $py -m pip install --force-reinstall --no-deps --quiet yt-dlp | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Khong cai lai duoc yt-dlp trong venv moi (setup-render.ps1 se thu lai)' }
}

# Đăng ký lại task về một thư mục cài đã có (quay về chỗ cũ khi chuyển không thành).
function Restore-AgInstallTasks {
  param([string]$InstallDir, [string[]]$Roles, [string]$OllamaModels)
  Set-AgInstallDirRecord $InstallDir
  if ($OllamaModels) { [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $OllamaModels, 'Machine') }
  $serve = Join-Path $InstallDir 'ollama\ollama-serve.cmd'
  if (Test-Path -LiteralPath $serve) { Register-AgTask -TaskName 'ag-farm-ollama' -CmdPath $serve -WorkDir (Split-Path -Parent $serve) -Priority 6 }
  foreach ($role in $Roles) {
    $roleDir = Join-Path $InstallDir $role
    Register-AgTask -TaskName "ag-farm-$role" -CmdPath (Join-Path $roleDir 'app\run.cmd') -WorkDir (Join-Path $roleDir 'app') -Priority (Get-AgRolePriority $role)
  }
  if (Test-Path -LiteralPath (Join-Path $InstallDir 'updater\update.ps1')) { Register-AgUpdaterTask -InstallDir $InstallDir }
}

# Chuyển máy đã cài sang thư mục khác (thường là ổ khác), giữ token, config, venv, model, log:
#   iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Move-AgWorker -To D:\ag-farm
# Dừng worker (việc đang chạy dở được hub giao lại khi hết lease), chép thư mục cài sang chỗ mới (bỏ work, staging, tmp;
# cache chỉ chép khi -CopyCache), đổi đường dẫn trong config.yaml, rồi chạy Install-AgWorker ở chỗ mới (tải gói mới
# nhất, setup-render.ps1, đăng ký lại task). Lỗi, hoặc worker ở chỗ mới không gửi heartbeat thì đăng ký task về chỗ cũ
# (thư mục cũ chưa bị đụng). Xong thì hỏi xoá thư mục cũ (-Yes: xoá luôn).
function Move-AgWorker {
  param(
    [Parameter(Mandatory = $true)][string]$To,
    # Bỏ trống: chỗ máy đã cài (Find-AgInstallDir).
    [string]$From,
    # Bỏ trống: hub_url trong config.yaml.
    [string]$Hub,
    [switch]$CopyCache,
    [switch]$Yes
  )
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if (-not (Test-AgAdmin)) { throw 'Hay mo PowerShell bang "Run as Administrator" roi chay lai lenh.' }

  if (-not $From) { $From = Find-AgInstallDir }
  if (-not $From) { throw 'Khong tim thay thu muc cai worker tren may nay (truyen -From <thu muc>)' }
  $From = ConvertTo-AgInstallDir $From
  $To = ConvertTo-AgInstallDir $To
  if (Test-AgSamePath $From $To) { throw "Worker da o $To" }
  if ((Test-AgPathUnder $To $From) -or (Test-AgPathUnder $From $To)) { throw "$From va $To khong duoc nam trong nhau" }
  if ((Test-Path -LiteralPath $To) -and @(Get-ChildItem -Force -LiteralPath $To).Count -gt 0) { throw "$To da co file: chon thu muc trong hoac chua co" }

  $roles = @($AgRolePackages.Keys | Where-Object { Test-Path -LiteralPath (Join-Path $From "$_\config.yaml") })
  if ($roles.Count -eq 0) { throw "$From khong co worker nao (thieu <vai tro>\config.yaml)" }
  if (-not $Hub) { $Hub = Read-AgConfigValue (Join-Path $From "$($roles[0])\config.yaml") 'hub_url' }
  $Hub = $Hub.TrimEnd('/')

  $exclude = Get-AgMoveExcludes -From $From -Roles $roles -CopyCache:$CopyCache
  $need = Get-AgDirSize -Path $From -Exclude $exclude
  $drive = (Split-Path -Qualifier $To).TrimEnd(':')
  $free = (Get-PSDrive -Name $drive).Free
  if ($free -lt $need + 20GB) {
    throw "O $drive con $([Math]::Round($free / 1GB)) GB, can $([Math]::Round(($need + 20GB) / 1GB)) GB ($([Math]::Round($need / 1GB, 1)) GB can chep + 20 GB cho viec)"
  }
  Write-Host "Chuyen worker $($roles -join ', ') tu $From sang $To (chep $([Math]::Round($need / 1GB, 1)) GB)"
  if (-not (Confirm-AgStep 'Worker se dung trong luc chuyen, viec dang chay do duoc hub giao lai sau khi het lease. Tiep tuc?' -Yes:$Yes)) { throw 'Da huy' }

  $oldModels = [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'Machine')
  Stop-AgInstall -InstallDir $From
  $moved = $false
  try {
    Copy-AgTree -From $From -To $To -Exclude $exclude
    # Model Ollama nằm ngoài thư mục cài (thư mục của người cài trên ổ C): chép theo để khỏi tải lại.
    if ($roles -contains 'scan' -and $oldModels -and -not (Test-AgPathUnder $oldModels $From) -and (Test-Path -LiteralPath (Join-Path $oldModels 'manifests'))) {
      Copy-AgTree -From $oldModels -To (Join-Path $To 'ollama\models')
    }
    foreach ($role in $roles) {
      $cfg = Join-Path $To "$role\config.yaml"
      $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $cfg
      [IO.File]::WriteAllText($cfg, (Convert-AgConfigPaths -Text $text -From $From -To $To), (New-Object Text.UTF8Encoding($false)))
    }
    Repair-AgVenvLaunchers -InstallDir $To
    # Install-AgWorker tìm thư mục cài ở registry: trỏ sang chỗ mới trước để nó không hỏi "máy đang cài ở chỗ khác".
    Set-AgInstallDirRecord $To
    $startedAt = Get-Date
    Install-AgWorker -Hub $Hub -InstallDir $To -Yes

    $moved = $true
    foreach ($role in $roles) {
      $token = Read-AgConfigValue (Join-Path $To "$role\config.yaml") 'token'
      if (-not (Wait-AgOnline -Hub $Hub -Token $token -Seconds 60 -Since $startedAt)) {
        Write-Warning "$role chua gui heartbeat tu $To"
        $moved = $false
      }
    }
    if (-not $moved) { throw "Worker o $To chua chay (xem $To\<vai tro>\logs\worker.log)" }
  } catch {
    Write-Warning "Chuyen loi: $($_.Exception.Message). Dang ky lai worker o $From"
    Stop-AgInstall -InstallDir $To
    Restore-AgInstallTasks -InstallDir $From -Roles $roles -OllamaModels $oldModels
    Write-Warning "Worker chay lai o $From. Thu muc $To giu nguyen de xem log; xoa tay roi chay lai Move-AgWorker."
    throw
  }

  Write-Host "Worker da chay o $To" -ForegroundColor Green
  if (Confirm-AgStep "Xoa thu muc cu $From?" -Yes:$Yes) {
    Remove-Item -Recurse -Force -LiteralPath $From -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $From) { Write-Warning "Con file trong $From chua xoa duoc (dang bi khoa): xoa tay sau khi khoi dong lai may" }
    else { Write-Host "Da xoa $From" }
  }
}
