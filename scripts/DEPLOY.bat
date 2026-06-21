@echo off
cd /d "C:\Users\begsh\crypto-trading-bot"
echo.
echo === gh CLI pruefen ===
gh --version >nul 2>&1
if %errorlevel% neq 0 (
    echo gh nicht gefunden. Installiere via winget...
    winget install --id GitHub.cli -e --source winget
    echo.
    echo Starte DEPLOY.bat erneut nach Installation!
    pause
    exit /b
)
gh --version

echo.
echo === GitHub Login pruefen ===
gh auth status
if %errorlevel% neq 0 (
    echo Nicht eingeloggt. Browser oeffnet sich...
    gh auth login --hostname github.com --git-protocol https --web
)

echo.
echo === .env Sicherheitscheck ===
git ls-files .env > tmp_check.txt
set /p ENVCHECK=<tmp_check.txt
del tmp_check.txt
if "%ENVCHECK%"==".env" (
    echo ACHTUNG: .env ist getrackt! Entferne...
    git rm --cached .env
)

echo.
echo === railway.json und alles committen ===
git add railway.json
git status
git commit -m "Add railway.json for Railway deploy"

echo.
echo === GitHub Repo anlegen und pushen ===
gh repo create crypto-trading-bot --private --source=. --remote=origin --push

echo.
echo === Verifikation - Dateien im Repo ===
for /f %%i in ('gh api user --jq .login') do set GHUSER=%%i
echo Repo: https://github.com/%GHUSER%/crypto-trading-bot
gh repo view crypto-trading-bot --json name,isPrivate

echo.
echo === FERTIG! Melde dich bei Claude. ===
pause
