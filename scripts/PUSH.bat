@echo off
cd /d "C:\Users\begsh\crypto-trading-bot"
echo.
echo === Auth-Status ===
gh auth status
if %errorlevel% neq 0 (
    echo NICHT eingeloggt! Bitte zuerst DEPLOY2.bat ausfuehren.
    cmd /k
    exit /b 1
)
echo.
echo === .env Check ===
git ls-files --error-unmatch .env >nul 2>&1 && (
    echo ACHTUNG .env wird entfernt!
    git rm --cached .env
) || echo .env sicher - nicht getrackt.
echo.
echo === Commit railway.json ===
git add railway.json
git commit -m "Add railway.json for Railway deploy" 2>&1
echo.
echo === GitHub Repo anlegen + Push ===
gh repo create crypto-trading-bot --private --source=. --remote=origin --push
echo.
echo === Ergebnis ===
gh repo view crypto-trading-bot
echo.
echo === FERTIG - melde dich bei Claude ===
cmd /k
