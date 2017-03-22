if (process.platform === 'win32') return;

var assert = require("assert");
var UnixTerminal = require('../lib/unixTerminal').UnixTerminal;

describe("UnixTermios", function() {
  beforeEach(function() {
    term = UnixTerminal.open();
  });
  it("getAttributes", function () {
    var attrs = term.getAttributes();
    assert.equal(attrs.hasOwnProperty('c_iflag'), true);
    assert.equal(attrs.hasOwnProperty('c_oflag'), true);
    assert.equal(attrs.hasOwnProperty('c_cflag'), true);
    assert.equal(attrs.hasOwnProperty('c_lflag'), true);
    assert.equal(attrs.hasOwnProperty('c_cc'), true);
  });
  it("getAttributes/setAttributes cycle", function () {
    var attrs = term.getAttributes();
    attrs.c_lflag.ICANON = false;
    assert.equal(attrs.c_cc.VSTART, '\x11'); // 17 --> ^Q
    attrs.c_cc.VSTART = '\x00';
    term.setAttributes(attrs, "TCSANOW");
    var attrs2 = term.getAttributes();
    assert.deepEqual(attrs.c_lflag, attrs2.c_lflag);
    assert.equal(attrs.c_cc.VSTART, '\x00');
  });
  it("setAttributes subset", function () {
    var orig = term.getAttributes();
    assert.equal(orig.c_lflag.ICANON, true);
    term.setAttributes({c_lflag: {ICANON: false}}, "TCSANOW");
    var attrs = term.getAttributes();
    assert.equal(attrs.c_lflag.ICANON, false);
    attrs.c_lflag.ICANON = true;
    assert.deepEqual(orig, attrs);
  });
});