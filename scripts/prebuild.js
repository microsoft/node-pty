const { spawnSync } = require('child_process');
const path = require('path');

const pkg = require(path.resolve('package.json'));

const regex = new RegExp('^\\d+\.\\d+\.\\d+$');

function spawnPrebuild(args) {
  let command = 'prebuild';
  if (process.platform === 'win32') {
    command = 'prebuild.cmd';
  }
  command = path.join(
    'node_modules',
    '.bin',
    command
  );
  let p = spawnSync(
    command,
    args,
    {
      stdio: 'inherit'
    }
  );
  if (p.error) {
    throw p.error;
  }
}

function main() {
  let nodeMajorVersionRegex = new RegExp('^([^.]+)\..*$');
  let nodeMajorVersion = process.versions.node.replace(nodeMajorVersionRegex, '$1');
  let baseArgs = [
    '--strip',
    '--verbose'
  ];
  // This is here to ensure only one major version builds for all supported
  // prebuild targets.
  if (nodeMajorVersion === "8") {
    baseArgs = baseArgs.concat(['--all']);
  }
  if (pkg.version.match(regex) && process.env.PREBUILD_UPLOAD_TOKEN) {
    baseArgs = baseArgs.concat([
      '--upload',
      process.env.PREBUILD_UPLOAD_TOKEN
    ]);
  }
  let args = baseArgs;
  spawnPrebuild(args);
  if (process.arch === 'x64' && process.platform === 'linux') {
    args = args.concat([
      '--arch',
      'ia32'
    ]);
    spawnPrebuild(args);
  }
}

if (require.main === module) {
  main();
}
