if (process.platform === 'win32') return

var assert = require("assert");
var UnixTerminal = require('../lib/unixTerminal').UnixTerminal;

describe("UnixTerminal", function() {
  describe("Constructor", function() {
    it("should set a valid pts name", function() {
      const term = new UnixTerminal('cmd.exe', [], {});
      let regExp;
      if (process.platform === 'linux') {
        // https://linux.die.net/man/4/pts
        regExp = /^\/dev\/pts\/\d+$/;
      }
      if (process.platform === 'darwin') {
        // https://developer.apple.com/legacy/library/documentation/Darwin/Reference/ManPages/man4/pty.4.html
        regExp = /^\/dev\/tty[p-sP-S][a-z0-9]$/;
      }
      assert.ok(regExp.test(term.pty), '"' + term.pty + '" should match ' + regExp.toString());
    });
  });
});
