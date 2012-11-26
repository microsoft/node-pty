var assert = require('assert');

// testing reading data from stdin, since that's a crucial feature
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
} else {
  tty.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');

// the child script expects 1 data event, with the text "☃"
var dataCount = 0;
process.stdin.on('data', function (data) {
  dataCount++;
  assert.equal(data, '☃');

  // done!
  process.stdin.pause();
  clearTimeout(timeout);
});

var timeout = setTimeout(function () {
  console.error('TIMEOUT!');
  process.exit(7);
}, 5000);

process.on('exit', function (code) {
  if (code === 7) return; // timeout
  assert.equal(dataCount, 1);
});
