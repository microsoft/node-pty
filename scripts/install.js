'use strict'

const os = require('os');
const path = require('path');
const spawn = require('child_process').spawn;

const args = ['rebuild'];
if (process.env.NODE_PTY_DEBUG) {
  args.push('--debug');
}
const p = spawn(os.platform() === 'win32' ? 'node-gyp.cmd' : 'node-gyp', args, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});

p.on('exit', function (code) {
  process.exit(code);
});
