
var assert = require('assert');
var pty = require('../lib/pty.js');
var tty = require('tty');
var term = pty.openpty();

assert(tty.isatty(term.master));
assert(tty.isatty(term.slave));

var slavebuf = '';
term.slave.on('data', function(data) {
  slavebuf += data;
});

var masterbuf = '';
term.master.on('data', function(data) {
  masterbuf += data;
});

setTimeout(function() {
  assert.equal(masterbuf, "slave\r\nmaster\r\n");
  assert.equal(slavebuf, "master\n");
  term.slave.destroy();
  term.master.destroy();
}, 200);

term.slave.write("slave\n");
term.master.write("master\n");

