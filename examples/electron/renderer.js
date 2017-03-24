var os = require('os');

var pty = require('node-pty');
var Terminal = require('xterm');

const shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'];
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.cwd(),
  env: process.env
});

const xterm = new Terminal();
xterm.open(document.getElementById('xterm'));

xterm.on('data', (data) => {
  ptyProcess.write(data);
});
ptyProcess.on('data', function (data) {
  xterm.write(data);
});
