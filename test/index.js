/**
 * pty.js test
 */

var assert = require('assert');
var pty = require('../');

var term = pty.fork(process.execPath, [ 'child-test.js' ], { cwd: __dirname });

// any output is considered failure. this is only a workaround
// until the actual error code is passed through
var count = 0;
term.on('data', function (data) {
  count++;
});

// pipe output to our stderr
term.pipe(process.stderr);

// make sure 'file' gets set properly
assert.equal(term.file, process.execPath);

// wait 1 second for node to spawn, and do its initial checks
setTimeout(function () {

  // test resize()
  term.resize(100, 100);

  // test writing unicode data
  term.write('☃');

  term.end();

}, 1000);

var gotTermExit = false;
term.on('exit', function (code) {
  gotTermExit = true;
  // TODO: ensure exit code is 0
  if (count) {
    process.exit(1);
  }
});

process.on('exit', function (code) {
  assert.equal(gotTermExit, true);
  if (code) {
    console.error('Tests FAILED');
  } else {
    console.error('Tests PASSED');
  }
});
