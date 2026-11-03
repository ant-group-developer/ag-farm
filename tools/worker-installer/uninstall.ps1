# ag-farm: gỡ worker khỏi máy (chạy bằng "Run as Administrator").
#   iwr https://<farm>/dist/uninstall.ps1 -UseBasicParsing | iex; Uninstall-AgWorker [-RemoveFiles]
# Mặc định chỉ gỡ task và dừng worker, giữ thư mục cài (config, cache, model). -RemoveFiles xoá cả thư mục.
# Thư mục cài: -InstallDir, bỏ trống thì chỗ install.ps1 đã cài (registry HKLM\SOFTWARE\ag-farm, task ag-farm-*),
# không thấy thì C:\ag-farm.
# Node trên hub vẫn còn: tắt hoặc xoá ở trang Máy của web farm.

# Giống Find-AgInstallDir của install.ps1 (file này chạy riêng nên có bản của nó).
function Find-AgUninstallDir {
  try {
    $dir = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\ag-farm' -Name InstallDir -ErrorAction Stop).InstallDir
    if ($dir -and (Test-Path -LiteralPath $dir)) { return $dir }
  } catch { }
  foreach ($role in @('scan', 'render')) {
    $task = Get-ScheduledTask -TaskName "ag-farm-$role" -ErrorAction SilentlyContinue
    foreach ($a in @($task.Actions)) {
      if ("$($a.Arguments)" -match '([A-Za-z]:\\[^"]*?)\\(scan|render)\\app\\run\.cmd' -and (Test-Path -LiteralPath $Matches[1])) { return $Matches[1] }
    }
  }
  return 'C:\ag-farm'
}

function Uninstall-AgWorker {
  param([string]$InstallDir, [switch]$RemoveFiles)
  $ErrorActionPreference = 'Stop'
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Hay mo PowerShell bang "Run as Administrator" roi chay lai lenh.'
  }
  if (-not $InstallDir) { $InstallDir = Find-AgUninstallDir }
  $InstallDir = $InstallDir.TrimEnd('\')
  Write-Host "Thu muc cai: $InstallDir"
  foreach ($task in @('ag-farm-updater', 'ag-farm-scan', 'ag-farm-render', 'ag-farm-ollama')) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
      Write-Host "Da go task $task"
    }
  }
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='ollama.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($InstallDir) -or $_.CommandLine -match 'ollama(\.exe)?"? serve') }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'ag-farm.url'
  Remove-Item -Force -LiteralPath $shortcut -ErrorAction SilentlyContinue
  if ($RemoveFiles) {
    Remove-Item -Recurse -Force -LiteralPath $InstallDir -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -LiteralPath 'HKLM:\SOFTWARE\ag-farm' -ErrorAction SilentlyContinue
    Write-Host "Da xoa $InstallDir"
  }
  Write-Host 'Xong.' -ForegroundColor Green
}
