const { spawn } = require('child_process');

function start(name, script) {
  const proc = spawn('node', [script], { stdio: 'inherit' });
  proc.on('close', (code) => {
    console.log('[launcher] ' + name + ' exited with code ' + code + ' — restarting in 5s…');
    setTimeout(() => start(name, script), 5000);
  });
  proc.on('error', (err) => {
    console.error('[launcher] ' + name + ' error:', err.message);
  });
  console.log('[launcher] Started ' + name + ' (PID ' + proc.pid + ')');
}

start('bot',    'dist/bot.js');
start('worker', 'dist/worker.js');
