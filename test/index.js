/**
 * pty.js test
 */

var assert = require('assert');
var Terminal = require('pty.js');

var term = new Terminal('sh', [], { name: 'vt100' });

var buff = '';

// avoid the first bytes output
setTimeout(function() {
  term.write('echo "$TERM"\r');
  term.on('data', function(data) {
    buff += data;
  });

  setTimeout(function() {
    assert.equal(buff.substring(0, 19), 'echo "$TERM"\r\nvt100');
    assert.equal(term.getProcessName(), 'sh');
    console.log('Completed successfully.');
    process.exit(0);
  }, 200);
}, 200);

// assert static constructor works
assert.equal(Terminal('sh', [], { name: 'test' }).name, 'test');
