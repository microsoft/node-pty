var pty = require('.');

var term = pty.spawn('powershell.exe', [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: 'C:\\',
  env: process.env
});

term.on('data', function(data) {
  console.log(data);
});

term.write('ls\r');
term.resize(100, 40);

console.log(term.process);

setTimeout(() => {
  term.kill();
  setTimeout(() => {
    process.exit(0);
  }, 200);
}, 2000);