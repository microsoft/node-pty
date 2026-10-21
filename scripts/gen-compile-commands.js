/**
 * Copyright (c) 2025, Microsoft Corporation (MIT License).
 */

const { execFileSync } = require('child_process');

console.log(`\x1b[32m> Generating compile_commands.json...\x1b[0m`);
if (!process.env.npm_config_node_gyp) {
  throw new Error('npm_config_node_gyp is not set; run this script with npm run compileCommands');
}
execFileSync(process.execPath, [process.env.npm_config_node_gyp, 'configure', '--', '-f', 'compile_commands_json'], { stdio: 'inherit' });
