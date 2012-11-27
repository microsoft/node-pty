var assert = require('assert');

assert.equal(process.getuid(), 777);
assert.equal(process.getgid(), 777);
