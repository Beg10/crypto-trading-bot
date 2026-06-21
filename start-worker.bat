@echo off
cd /d "%~dp0"
git add src/services/analysis.ts src/worker.ts src/types.ts src/db.ts src/bot.ts src/commands/status.ts supabase/migrations/003_signal_log.sql
git commit -m "feat: EMA50 trend filter + volume filter + signal logging + /status command + auto break-even"
git push
echo.
echo Gepusht! Railway deployt automatisch.
pause
