//@ts-check

const path = require('path');
const { spawnSync } = require('child_process');

const prebuildScript = path.join(__dirname, 'prebuild.js');
const prebuildResult = spawnSync(process.execPath, [prebuildScript], {
  stdio: 'inherit'
});

if (prebuildResult.error) {
  console.error(prebuildResult.error);
  process.exit(1);
}

if (prebuildResult.status === 0) {
  process.exit(0);
}

const isWindows = process.platform === 'win32';
const nodeGypCommand = isWindows ? 'node-gyp.cmd' : 'node-gyp';
const rebuildCommand = isWindows ? process.env.ComSpec || 'cmd.exe' : nodeGypCommand;
const rebuildArguments = isWindows
  ? ['/d', '/s', '/c', `${nodeGypCommand} rebuild`]
  : ['rebuild'];
const rebuildResult = spawnSync(rebuildCommand, rebuildArguments, {
  stdio: 'inherit',
  shell: false
});

if (rebuildResult.error) {
  console.error(rebuildResult.error);
  process.exit(1);
}

process.exit(rebuildResult.status === null ? 1 : rebuildResult.status);
