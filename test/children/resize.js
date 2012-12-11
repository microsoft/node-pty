var assert = require('assert');

// the test runner will call "term.resize(100, 100)" after 1 second
process.on('SIGWINCH', function () {
  var size = process.stdout.getWindowSize();
  assert.equal(size[0], 100);
  assert.equal(size[1], 100);
  clearTimeout(timeout);
});

var timeout = setTimeout(function () {
  console.error('TIMEOUT!');
  process.exit(7);
}, 5000);
