if (process.platform !== 'win32') return

var argvToCommandLine = require('../').argvToCommandLine
var assert = require("assert");

function check(input, expected) {
  assert.equal(argvToCommandLine(input), expected);
}

describe("argvToCommandLine", function() {
  describe("Plain strings", function() {
    it("doesn't quote plain string", function() {
      check(['asdf'], 'asdf');
    });
    it("doesn't escape backslashes", function() {
      check(['\\asdf\\qwer\\'], '\\asdf\\qwer\\');
    });
    it("doesn't escape multiple backslashes", function() {
      check(['asdf\\\\qwer'], 'asdf\\\\qwer');
    });
    it("adds backslashes before quotes", function() {
      check(['"asdf"qwer"'], '\\"asdf\\"qwer\\"');
    });
    it("escapes backslashes before quotes", function() {
      check(['asdf\\"qwer'], 'asdf\\\\\\"qwer');
    });
  });

  describe("Quoted strings", function() {
    it("quotes string with spaces", function() {
      check(['asdf qwer'], '"asdf qwer"');
    });
    it("quotes empty string", function() {
      check([''], '""');
    });
    it("quotes string with tabs", function() {
      check(['asdf\tqwer'], '"asdf\tqwer"');
    });
    it("escapes only the last backslash", function() {
      check(['\\asdf \\qwer\\'], '"\\asdf \\qwer\\\\"');
    });
    it("doesn't escape multiple backslashes", function() {
      check(['asdf \\\\qwer'], '"asdf \\\\qwer"');
    });
    it("adds backslashes before quotes", function() {
      check(['"asdf "qwer"'], '"\\"asdf \\"qwer\\""');
    });
    it("escapes backslashes before quotes", function() {
      check(['asdf \\"qwer'], '"asdf \\\\\\"qwer"');
    });
    it("escapes multiple backslashes at the end", function() {
      check(['asdf qwer\\\\'], '"asdf qwer\\\\\\\\"');
    });
  });

  describe("Multiple arguments", function() {
    it("joins arguments with spaces", function() {
      check(['asdf', 'qwer zxcv', '', '"'], 'asdf "qwer zxcv" "" \\"');
    });
  });
});
