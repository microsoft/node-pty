var pty = require('./lib/index.js');

var os = require('os');

var shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

var ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 25,
    cwd: process.env.HOME,
    env: process.env
});

ptyProcess.on('data', function(data) {
    console.log(data);
});

console.log(ptyProcess.tcgetattr());
var pty_options = ptyProcess.tcgetattr();
pty_options.c_lflag &= ~ptyProcess.TERMIOS.ICANON;
ptyProcess.tcsetattr(ptyProcess.TERMIOS.TCSANOW, pty_options);
console.log(ptyProcess.tcgetattr());