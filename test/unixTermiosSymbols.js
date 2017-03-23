if (process.platform === 'win32') return;

var assert = require("assert");
var UnixTerminal = require('../lib/unixTerminal').UnixTerminal;

function switchValues(obj, value) {
  for (key in obj)
    if (obj.hasOwnProperty(key))
        obj[key] = value;
}

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
  it("set c_iflags", function () {
    var c_iflag = term.getAttributes().c_iflag;
    switchValues(c_iflag, false);
    term.setAttributes({c_iflag: c_iflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_iflag, c_iflag);
    switchValues(c_iflag, true);
    term.setAttributes({c_iflag: c_iflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_iflag, c_iflag);
  });
  it("set c_oflags", function () {
    var c_oflag = term.getAttributes().c_oflag;
    switchValues(c_oflag, false);
    c_oflag.TAB0 = false;
    term.setAttributes({c_oflag: c_oflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_oflag, c_oflag);
    switchValues(c_oflag, true);
    c_oflag.TAB0 = false;
    term.setAttributes({c_oflag: c_oflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_oflag, c_oflag);
  });
  it("set c_cflags", function () {
    var c_cflag = term.getAttributes().c_cflag;
    switchValues(c_cflag, false);
    c_cflag.CREAD = true; // not working with false
    c_cflag.CSIZE = true; // not working without CS5, CS6, CS7, or CS8
    c_cflag.CS5 = false;
    c_cflag.CS6 = true;
    c_cflag.CS7 = true;
    c_cflag.CS8 = true;
    term.setAttributes({c_cflag: c_cflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_cflag, c_cflag);
    switchValues(c_cflag, true);
    c_cflag.PARENB = false; // not working with true
    c_cflag.CS5 = false;
    c_cflag.CS6 = true;
    c_cflag.CS7 = true;
    c_cflag.CS8 = true;
    term.setAttributes({c_cflag: c_cflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_cflag, c_cflag);
  });
  it("set c_lflags", function () {
    var c_lflag = term.getAttributes().c_lflag;
    switchValues(c_lflag, false);
    term.setAttributes({c_lflag: c_lflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_lflag, c_lflag);
    switchValues(c_lflag, true);
    if (c_lflag.hasOwnProperty('EXTPROC'))
      c_lflag.EXTPROC = false;
    term.setAttributes({c_lflag: c_lflag}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_lflag, c_lflag);
  });
  it("set c_cc", function () {
    var c_cc = term.getAttributes().c_cc;
    switchValues(c_cc, '\x00');
    c_cc.VTIME = 0;
    c_cc.VMIN = 0;
    term.setAttributes({c_cc: c_cc}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_cc, c_cc);
    switchValues(c_cc, '\x01');
    c_cc.VTIME = 1;
    c_cc.VMIN = 1;
    term.setAttributes({c_cc: c_cc}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_cc, c_cc);
    switchValues(c_cc, '\xff');
    c_cc.VTIME = 255;
    c_cc.VMIN = 255;
    term.setAttributes({c_cc: c_cc}, "TCSANOW");
    assert.deepEqual(term.getAttributes().c_cc, c_cc);
  });
});