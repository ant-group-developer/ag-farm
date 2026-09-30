@echo off
rem ag-farm worker supervisor: Task Scheduler chay file nay luc bat may (tai khoan SYSTEM).
rem Worker thoat hay chet thi 10 giay sau chay lai. Cau hinh o ..\config.yaml, log o ..\logs\.
setlocal
cd /d "%~dp0"
if not exist "..\logs" mkdir "..\logs"
:loop
for %%F in ("..\logs\worker.log") do if %%~zF GTR 20971520 move /y "..\logs\worker.log" "..\logs\worker.1.log" >nul
"%~dp0runtime\node.exe" "%~dp0dist\worker.mjs" --config "%~dp0..\config.yaml" >> "..\logs\worker.log" 2>&1
echo [%date% %time%] worker exited with code %errorlevel%, restarting in 10 s >> "..\logs\worker.log"
ping -n 11 127.0.0.1 >nul
goto loop
