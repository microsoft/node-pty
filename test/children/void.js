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
