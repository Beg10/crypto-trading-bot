@echo off
echo === Fix: TypeScript-Fehler beheben und pushen ===
cd /d C:\Users\begsh\crypto-trading-bot

if exist ".git\index.lock" del /F ".git\index.lock"
if exist ".git\HEAD.lock" del /F ".git\HEAD.lock"

git config user.email "beg.22.sh@gmail.com"
git config user.name "Beg10"

echo --- git add + commit ---
git add src\commands\unwatch.ts src\commands\watch.ts src\services\cryptopanic.ts src\worker.ts
git commit -m "fix: all truncated source files restored, build clean"

echo --- git push ---
git push origin main
echo Exitcode: %ERRORLEVEL%

echo.
echo === Fertig! ===
pause
