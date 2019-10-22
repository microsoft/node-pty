var os = require('os');
var pty = require('../..');

var isWindows = os.platform() === 'win32';
var shell = isWindows ? 'powershell.exe' : 'bash';

var ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 26,
  cwd: isWindows ? process.env.USERPROFILE : process.env.HOME,
  env: Object.assign({ TEST: "Environment vars work" }, process.env),
  useConpty: true
});

ptyProcess.onData(data => process.stdout.write(data));

ptyProcess.write(isWindows ? 'dir\r' : 'ls\r');

setTimeout(() => {
  ptyProcess.resize(30, 19);
  ptyProcess.write(isWindows ? '$Env:TEST\r' : 'echo $TEST\r');
}, 2000);

process.on('exit', () => ptyProcess.kill());

setTimeout(() => process.exit(), 4000);
