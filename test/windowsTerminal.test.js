if (process.platform !== 'win32') return

var assert = require("assert");
var WindowsTerminal = require('../lib/windowsTerminal').WindowsTerminal;

describe("WindowsTerminal", function() {
  describe("kill", function() {
    it("should not crash parent process", function(done) {
      const term = new WindowsTerminal('cmd.exe', [], {});
      term.kill();
      // Add done call to deferred function queue to ensure the kill call has completed
      term._defer(done);
    });
  });
});
