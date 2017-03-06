'use strict'

const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnSync = require('child_process').spawnSync;

const root = path.join(__dirname, '..');

spawnSync(os.platform() === 'win32' ? 'node-gyp.cmd' : 'node-gyp', ['rebuild'], {
  cwd: root,
  stdio: 'inherit'
});

// Copy winpty binaries to the output dir
if (os.platform() === 'win32') {
  const binaryDir = path.join(root, 'deps', 'winpty-0.4.2-msvc2015', os.arch(), 'bin');
  const outputDir = path.join(root, 'build', 'Release');
  const files = ['winpty-agent.exe', 'winpty.dll'];
  files.forEach(f => {
    fs.createReadStream(path.join(binaryDir, f)).pipe(fs.createWriteStream(path.join(outputDir, f)));
  });
}
