@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONLEGACYWINDOWSSTDIO=1"
set "START_URL=http://127.0.0.1:8765/"

echo ========================================
echo   Movie AutoCut - Startup Script
echo ========================================
echo.

if not exist "venv" (
    echo [*] Creating virtual environment...
    python -m venv venv
    echo [OK] Virtual environment created.
)

echo [*] Installing dependencies...
venv\Scripts\python.exe -m pip install -r requirements.txt -q

echo.
echo [*] Starting Server...
echo [*] Browser will open automatically.
echo [*] Press Ctrl+C to exit.
echo.

if /I not "%MOVIE_AUTOCUT_SKIP_BROWSER%"=="1" (
    start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$url='%START_URL%'; for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null; explorer.exe $url; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; explorer.exe $url"
)

venv\Scripts\python.exe server.py

endlocal
pause
