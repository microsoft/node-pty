if (process.platform === 'win32') return;

var assert = require("assert");
var UnixTerminal = require('../lib/unixTerminal').UnixTerminal;
var TERMIOS = require('../lib/unixTerminal').UnixTerminal.TERMIOS;

describe("UnixTermios", function() {
  beforeEach(function() {
    term = UnixTerminal.open();
  });
  it("termios symbols", function () {
    assert.notEqual(TERMIOS, undefined);
    assert.notEqual(TERMIOS, {});
    assert.equal(TERMIOS.hasOwnProperty('ICANON'), true);
    assert.equal(TERMIOS.hasOwnProperty('TCSANOW'), true);
  });
  it("tcgetattr", function () {
    var attrs = term.tcgetattr();
    assert.equal(attrs.hasOwnProperty('c_iflag'), true);
    assert.equal(attrs.hasOwnProperty('c_oflag'), true);
    assert.equal(attrs.hasOwnProperty('c_cflag'), true);
    assert.equal(attrs.hasOwnProperty('c_lflag'), true);
    assert.equal(attrs.hasOwnProperty('c_ispeed'), true);
    assert.equal(attrs.hasOwnProperty('c_ospeed'), true);
    assert.equal(attrs.hasOwnProperty('c_cc'), true);
  });
  it("tcgetattr/tcsetattr cycle", function () {
    var attrs = term.tcgetattr();
    attrs.c_lflag &= ~TERMIOS.ICANON;
    assert.equal(attrs.c_cc[TERMIOS.VSTART], 17); // 17 --> ^Q
    attrs.c_cc[TERMIOS.VSTART] = 0;
    term.tcsetattr(TERMIOS.TCSANOW, attrs);
    var attrs2 = term.tcgetattr();
    assert.equal(attrs.c_lflag, attrs2.c_lflag);
    assert.equal(attrs.c_cc[TERMIOS.VSTART], 0);
  });
});