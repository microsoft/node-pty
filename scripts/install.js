
'use strict'

const path = require('path');
const spawn = require('child_process').spawn;

spawn('node-gyp', ['rebuild'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});
