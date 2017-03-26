if (process.platform === 'win32') return

var assert = require("assert");
var UnixTerminal = require('../lib/unixTerminal').UnixTerminal;

describe("UnixTerminal", function() {
  describe("Constructor", function() {
    it("should set a valid pts name", function() {
      const term = new UnixTerminal('cmd.exe', [], {});
      // Should match form from https://linux.die.net/man/4/pts
      assert.ok(/^\/dev\/pts\/\d+$/.test(term.pty));
    });
  });
});
