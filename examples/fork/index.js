var os = require('os');
var pty = require('../..');

var shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

var ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 26,
  cwd: os.platform() === 'win32' ? process.env.USERPROFILE : process.env.HOME,
  env: Object.assign({ TEST: "abc" }, process.env),
  experimentalUseConpty: false
});

ptyProcess.on('data', function(data) {
  // console.log(data);
  process.stdout.write(data);
});

ptyProcess.write('dir\r');
// ptyProcess.write('ls\r');

setTimeout(() => {
  ptyProcess.resize(30, 19);
  ptyProcess.write('echo %TEST%\r');
}, 2000);

process.on('exit', () => {
  ptyProcess.kill();
});

setTimeout(() => {
  process.exit();
}, 4000);
