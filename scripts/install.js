'use strict'

const os = require('os');
const path = require('path');
const spawn = require('child_process').spawn;

spawn(os.platform() === 'win32' ? 'node-gyp.cmd' : 'node-gyp', ['rebuild'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});
