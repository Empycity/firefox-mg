@echo off
setlocal EnableExtensions
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
set "LOG_DIR=%SCRIPT_DIR%log"
set "PYTHON_EXE="
set "PYTHON_ARGS="

if defined DOUYIN_PYTHON if exist "%DOUYIN_PYTHON%" set "PYTHON_EXE=%DOUYIN_PYTHON%"
if defined PYTHON_EXE goto :python_ready

where python.exe >nul 2>nul
if not errorlevel 1 set "PYTHON_EXE=python.exe"
if defined PYTHON_EXE goto :python_ready

where py.exe >nul 2>nul
if not errorlevel 1 set "PYTHON_EXE=py.exe"
if defined PYTHON_EXE set "PYTHON_ARGS=-3"

:python_ready

if not defined PYTHON_EXE goto :missing_python

where node.exe >nul 2>nul
if errorlevel 1 goto :missing_node

where ffmpeg.exe >nul 2>nul
if errorlevel 1 goto :missing_ffmpeg

"%PYTHON_EXE%" %PYTHON_ARGS% -c "import curl_cffi, PIL" >nul 2>nul
if errorlevel 1 goto :install_requirements
goto :dependencies_ready

:install_requirements
echo [SETUP] Installing Python requirements...
"%PYTHON_EXE%" %PYTHON_ARGS% -m pip install -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 goto :dependency_failed

:dependencies_ready
set "PROGRAM=%SCRIPT_DIR%creator_publish.py"
set "COOKIE_FILE=%SCRIPT_DIR%cookie.txt"
set "V1=%SCRIPT_DIR%test-videos\test-video-1.mp4"
set "V2=%SCRIPT_DIR%test-videos\test-video-2.mp4"
set "V3=%SCRIPT_DIR%test-videos\test-video-3.mp4"
set "V4=%SCRIPT_DIR%test-videos\test-video-4.mp4"

call :require_file "%PROGRAM%"
if errorlevel 1 goto :missing_file
call :require_file "%COOKIE_FILE%"
if errorlevel 1 goto :missing_file
call :require_file "%SCRIPT_DIR%creator-runtime-contract.json"
if errorlevel 1 goto :missing_file
call :require_file "%SCRIPT_DIR%security-runtime.json"
if errorlevel 1 goto :missing_file
call :require_file "%SCRIPT_DIR%bdms-runner.js"
if errorlevel 1 goto :missing_file
call :require_file "%SCRIPT_DIR%assets\bdms_1.0.1.16.js"
if errorlevel 1 goto :missing_file
call :require_file "%V1%"
if errorlevel 1 goto :missing_file
call :require_file "%V2%"
if errorlevel 1 goto :missing_file
call :require_file "%V3%"
if errorlevel 1 goto :missing_file
call :require_file "%V4%"
if errorlevel 1 goto :missing_file

echo ============================================================
echo  Douyin Creator - publish 5 videos locally
echo ============================================================
echo Python: %PYTHON_EXE% %PYTHON_ARGS%
echo Visibility: PRIVATE ^(visibility_type=1^)
echo Download: ENABLED ^(download=1^)
echo Schedule: IMMEDIATE ^(timing=0^)
echo Cookie file: %COOKIE_FILE%
echo Video queue: 1, 2, 3, 4, 1
echo Success: HTTP 200 + status_code=0 + item_id
echo.
set "CONFIRM="
set /p "CONFIRM=Type YES to publish 5 private videos: "
if /I not "%CONFIRM%"=="YES" goto :cancelled

echo.
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%I"
set "RUN_LOG=%LOG_DIR%\run-5videos-%STAMP%.log"
echo Log: %RUN_LOG%
echo -------------------- START --------------------
"%PYTHON_EXE%" %PYTHON_ARGS% "%PROGRAM%" --video-batch "%V1%" "%V2%" "%V3%" "%V4%" "%V1%" --cookie-file "%COOKIE_FILE%" --text "local publish stability demo" --visibility-type 1 --download 1 --timing 0 --retries 2
set "STATUS=%errorlevel%"
echo --------------------- END ---------------------
echo Exit code: %STATUS%
pause
exit /b %STATUS%

:require_file
if exist "%~1" exit /b 0
echo [ERROR] Missing file: %~1
exit /b 1

:missing_python
echo [ERROR] Python 3.10 or newer was not found in PATH.
goto :failed

:missing_node
echo [ERROR] Node.js 18 or newer was not found in PATH.
goto :failed

:missing_ffmpeg
echo [ERROR] ffmpeg was not found in PATH.
goto :failed

:dependency_failed
echo [ERROR] Python dependency installation failed.
goto :failed

:missing_file
echo [ERROR] The delivery folder is incomplete.
goto :failed

:cancelled
echo Cancelled.
pause
exit /b 0

:failed
pause
exit /b 1
