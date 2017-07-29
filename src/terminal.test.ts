var assert = require("assert");
var Terminal = process.platform === 'win32' ? require('../lib/windowsTerminal').WindowsTerminal : require('../lib/unixTerminal').UnixTerminal;

describe("Terminal", function() {
  describe("constructor", function() {
    it("should do basic type checks", function() {
      assert.throws(() => {
        new Terminal('a', 'b', { 'name': {} });
      }, 'name must be a string (not a object)');
    });
  });
});
