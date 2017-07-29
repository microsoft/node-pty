if (process.platform !== 'win32') return

var fs = require('fs');
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

  describe("Args as CommandLine", function(done) {
    it("should not fail running a shell containing a space in the path", function(done) {
      const gitBashDefaultPath = "C:\\Program Files\\Git\\bin\\bash.exe";
      if (!fs.existsSync(gitBashDefaultPath)) {
        //Skip test if git bash isn't installed
        return;
      }
      const term = new WindowsTerminal(gitBashDefaultPath, '-c "echo helloworld"', {});
      let result = '';
      term.on('data', function (data) {
        result += data;
      });
      term.on('exit', function() {
        assert.ok(result.indexOf('helloworld') >= 0);
        done();
      });
    });
  });

  describe("On close", function(done) {
    it("should return process zero exit codes", function(done) {
      const term = new WindowsTerminal('cmd.exe', '/C exit');
      term.on('exit', function(code) {
        assert.equal(code, 0);
        done();
      });
    });

    it("should return process non-zero exit codes", function(done) {
      const term = new WindowsTerminal('cmd.exe', '/C exit 2');
      term.on('exit', function(code) {
        assert.equal(code, 2);
        done();
      });
    });
  });
});
