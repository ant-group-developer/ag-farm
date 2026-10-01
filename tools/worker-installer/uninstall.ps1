# ag-farm: gỡ worker khỏi máy (chạy bằng "Run as Administrator").
#   iwr https://<farm>/dist/uninstall.ps1 -UseBasicParsing | iex; Uninstall-AgWorker [-RemoveFiles]
# Mặc định chỉ gỡ task và dừng worker, giữ thư mục cài (config, cache, model). -RemoveFiles xoá cả thư mục.
# Node trên hub vẫn còn: tắt hoặc xoá ở trang Máy của web farm.

function Uninstall-AgWorker {
  param([string]$InstallDir = 'C:\ag-farm', [switch]$RemoveFiles)
  $ErrorActionPreference = 'Stop'
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Hay mo PowerShell bang "Run as Administrator" roi chay lai lenh.'
  }
  foreach ($task in @('ag-farm-scan', 'ag-farm-render', 'ag-farm-ollama')) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
      Write-Host "Da go task $task"
    }
  }
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='ollama.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($InstallDir) -or $_.CommandLine -match 'ollama(\.exe)?"? serve') }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($RemoveFiles) {
    Remove-Item -Recurse -Force -LiteralPath $InstallDir -ErrorAction SilentlyContinue
    Write-Host "Da xoa $InstallDir"
  }
  Write-Host 'Xong.' -ForegroundColor Green
}
