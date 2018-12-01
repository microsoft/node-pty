var pty = require('./lib/index');

var ptyProcess = pty.spawn('bash', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
});

// set callback for process name
// spawns a libuv thread for polling the process name
// if it changes the callback gets triggered
ptyProcess.setProcessNameCallback(name => console.log('processname:', name));

ptyProcess.on('data', data => {});

start = new Date;
ptyProcess.write('ls -lR /usr/lib\r');

setTimeout(() => {
  // remove callback for process name
  // stops the libuv name polling thread
  ptyProcess.setProcessNameCallback(null);
  ptyProcess.write('ls -lR /usr/lib\r');
}, 2000);

setTimeout(() => {
  // set callback for process name again
  ptyProcess.setProcessNameCallback(name => console.log('processname:', name));
  ptyProcess.write('ls -lR /usr/lib\rexit\r');
}, 4000);

// Note on pty exit: the process name thread gets joined automatically
//                   no need to explicitly remove the handler
