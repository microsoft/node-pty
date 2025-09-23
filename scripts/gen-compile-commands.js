/**
 * Copyright (c) 2025, Microsoft Corporation (MIT License).
 */

console.log(`\x1b[32m> Generating compile_commands.json...\x1b[0m`);
execSync('npx node-gyp configure -- -f compile_commands_json');
