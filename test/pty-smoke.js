// Exercise the public API of a packed/installed package, including companion files.
const assert = require('assert');
const path = require('path');
const root = path.resolve(process.argv[2]);
const start = process.hrtime.bigint();
const pty = require(root);
const loaded = process.hrtime.bigint();
const term = pty.spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  process.platform === 'win32' ? ['/c', 'echo packed-ok'] : ['-c', 'printf packed-ok'],
  { cwd: process.cwd(), env: process.env, useConptyDll: true });
let output = '';
term.onData(data => output += data);
term.onExit(({ exitCode }) => {
  assert.strictEqual(exitCode, 0);
  assert.ok(output.includes('packed-ok'), output);
  clearTimeout(timeout);
  console.log(JSON.stringify({ requireMs: Number(loaded - start) / 1e6, smoke: 'passed' }));
});
const timeout = setTimeout(() => { console.error('PTY smoke timed out'); process.exit(1); }, 10000);
