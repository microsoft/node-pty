var os = require('os');
var pty = require('../..');

var shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';

var ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 19,
  cwd: process.env.HOME,
  env: process.env
});

ptyProcess.on('data', function(data) {
  // console.log(data);
  process.stdout.write(data);
});

ptyProcess.write('dir\r');
// ptyProcess.write('ls\r');

setTimeout(() => {
  ptyProcess.resize(30, 19);
  ptyProcess.write('dir\r');
}, 2000);

process.on('exit', () => {
  ptyProcess.kill();
});

setTimeout(() => {
  process.exit();
}, 4000);
