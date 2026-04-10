@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONLEGACYWINDOWSSTDIO=1"
set "START_URL=http://127.0.0.1:8765/"
set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=venv-win"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

cd /d "%SCRIPT_DIR%"

set "BOOTSTRAP=python"
where python >nul 2>nul
if errorlevel 1 (
    where py >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Python was not found.
        pause
        exit /b 1
    )
    set "BOOTSTRAP=py -3"
)

echo ========================================
echo   Movie AutoCut - Startup Script
echo ========================================
echo.

if exist "%VENV_DIR%\pyvenv.cfg" (
    findstr /I /C:"/Library/Developer/CommandLineTools/usr/bin" "%VENV_DIR%\pyvenv.cfg" >nul 2>nul
    if not errorlevel 1 (
        echo [ERROR] Detected broken virtual environment metadata in %VENV_DIR%.
        echo [ERROR] Please remove %VENV_DIR% manually and run again.
        pause
        exit /b 1
    )
)

if not exist "%VENV_PYTHON%" (
    echo [*] Creating Windows virtual environment in %VENV_DIR%...
    %BOOTSTRAP% -m venv "%VENV_DIR%" --without-pip
    echo [OK] Virtual environment created.
)

echo [*] Installing dependencies...
%BOOTSTRAP% -m pip --python "%VENV_DIR%" install -r requirements.txt -q

echo.
echo [*] Starting Server...
echo [*] Browser will open automatically.
echo [*] Press Ctrl+C to exit.
echo.

if /I not "%MOVIE_AUTOCUT_SKIP_BROWSER%"=="1" (
    start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$url='%START_URL%'; for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null; explorer.exe $url; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; explorer.exe $url"
)

%VENV_PYTHON% server.py

endlocal
pause
