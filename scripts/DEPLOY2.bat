@echo off
cd /d "C:\Users\begsh\crypto-trading-bot"

echo.
echo === [1/5] gh CLI pruefen ===
gh --version >nul 2>&1
if %errorlevel% neq 0 (
    echo gh nicht gefunden. Installiere...
    winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements
    echo Installation abgeschlossen. Starte neu...
    goto :REPO
)
echo gh OK:
gh --version

echo.
echo === [2/5] GitHub Login pruefen ===
gh auth status >nul 2>&1
if %errorlevel% neq 0 (
    echo Nicht eingeloggt - Browser oeffnet sich automatisch...
    gh auth login --hostname github.com --git-protocol https --web
) else (
    echo Bereits eingeloggt.
    gh auth status
)

:REPO
echo.
echo === [3/5] .env Sicherheitscheck ===
git ls-files --error-unmatch .env >nul 2>&1
if %errorlevel% equ 0 (
    echo ACHTUNG: .env getrackt - entferne...
    git rm --cached .env
)
echo .env ist NICHT im Repo. Sicher.

echo.
echo === [4/5] railway.json committen und pushen ===
git add railway.json
git diff --cached --name-only
git commit -m "Add railway.json for Railway deploy" 2>&1 || echo Commit bereits vorhanden oder nichts zu committen.

echo.
echo === [5/5] GitHub Repo anlegen und pushen ===
gh repo create crypto-trading-bot --private --source=. --remote=origin --push

echo.
echo === FERTIG ===
echo Melde dich bei Claude!
echo (dieses Fenster offen lassen)
cmd /k
