
/**
 * This script gets run as a child process created by pty.js' spawn() function.
 */

var tty = require('tty');
var assert = require('assert');

// these two are huge. with vanilla node, it's impossible to spawn
// a child process that has the stdin and stdout fd's be isatty, except
// when passing through its own stdin and stdout which isn't always desirable
assert.ok(tty.isatty(0));
assert.ok(tty.isatty(1));

var size = process.stdout.getWindowSize();
assert.equal(size[0], 80);
assert.equal(size[1], 30);

// the test runner will call "term.resize(100, 100)" after 1 second
var gotSIGWINCH = false;
process.on('SIGWINCH', function () {
  gotSIGWINCH = true;
  size = process.stdout.getWindowSize();
  assert.equal(size[0], 100);
  assert.equal(size[1], 100);
});


// testing reading data from stdin, since that's a crucial feature
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
} else {
  tty.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');

// the child script expects 1 data event, with the text "☃"
var dataCount = 0;
process.stdin.on('data', function (data) {
  dataCount++;
  assert.equal(data, '☃');

  // done!
  process.stdin.pause();
  clearTimeout(timeout);
});

var timeout = setTimeout(function () {
  console.error('TIMEOUT!');
  process.exit(7);
}, 5000);

process.on('exit', function (code) {
  if (code === 7) return; // timeout
  assert.ok(gotSIGWINCH);
  assert.equal(dataCount, 1);
});
