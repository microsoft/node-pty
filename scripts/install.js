'use strict'

const os = require('os');
const path = require('path');
const spawn = require('child_process').spawn;

installWindowsProcessTree().then(() => {
  if (code) {
    throw new Error('npm i windows-process-tree failed with code ' + code);
  }
  const gypArgs = ['rebuild'];
  if (process.env.NODE_PTY_DEBUG) {
    gypArgs.push('--debug');
  }
  const gypProcess = spawn(os.platform() === 'win32' ? 'node-gyp.cmd' : 'node-gyp', gypArgs, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });

  gypProcess.on('exit', function (code) {
    process.exit(code);
  });
});

// windows-process-tree is an optional dev dependency which npm does not support
function installWindowsProcessTree() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve();
      return;
    }
    const npmArgs = ['i', '--no-save', 'windows-process-tree@0.2.3'];
    const npmProcess = spawn(os.platform() === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    npmProcess.on('exit', function (code) {
      if (code) {
        throw new Error('windows-process-tree install failed with code ' + code);
      }
      resolve();
    });
  });
}
