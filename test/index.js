var assert = require('assert');
var pty = require('../');
var mocha = require('mocha');

var tests = [
  {
    name: 'should be correctly setup',
    command: [ 'children/void.js' ],
    options: { cwd: __dirname },
    test: function () {
      assert.equal(this.file, process.execPath);
    }
  }, {
    name: 'should support stdin',
    command: [ 'children/stdin.js' ],
    options: { cwd: __dirname },
    test: function () {
      this.write('☃');
    }
  }, {
    name: 'should support resize',
    command: [ 'children/resize.js' ],
    options: { cwd: __dirname },
    test: function () {
      this.resize(100, 100);
    }
  }, {
    name: 'should change uid/gid',
    command: [ 'children/uidgid.js' ],
    options: { cwd: __dirname, uid: 777, gid: 777 },
    test: function () {}
  }
];

describe('Pty', function() {
  tests.forEach(function (testCase) {
    if (testCase.options.uid && testCase.options.gid && process.getgid() !== 0) {
      // Skip tests that contains user impersonation if we are not able to do so.
      return it.skip(testCase.name);
    }
    it(testCase.name, function (done) {
      var term = pty.fork(process.execPath, testCase.command, testCase.options);
      term.pipe(process.stderr);

      // any output is considered failure. this is only a workaround
      // until the actual error code is passed through
      var count = 0;
      term.on('data', function (data) {
        count++;
      });
      term.on('exit', function () {
        assert.equal(count, 0);
        done();
      });

      // Wait for pty to be ready
      setTimeout(testCase.test.bind(term), 1000);
    });
  });
});
