// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var fs = require('fs');
var util = require('util');
var Stream = require('stream').Stream;

var kMinPoolSpace = 128;
var kPoolSize = 40 * 1024;

var pool;

function allocNewPool() {
  pool = new Buffer(kPoolSize);
  pool.used = 0;
}

var ReadStream = exports.ReadStream = function(path, options) {
  if (!(this instanceof ReadStream)) return new ReadStream(path, options);

  Stream.call(this);

  var self = this;

  this.path = path;
  this.fd = null;
  this.readable = true;
  this.paused = false;

  this.flags = 'r';
  this.mode = 438; /*=0666*/
  this.bufferSize = 64 * 1024;

  this.stopEnd = options.stopEnd;

  options = options || {};

  // Mixin options into this
  var keys = Object.keys(options);
  for (var index = 0, length = keys.length; index < length; index++) {
    var key = keys[index];
    this[key] = options[key];
  }

  if (this.encoding) this.setEncoding(this.encoding);

  if (this.start !== undefined) {
    if ('number' !== typeof this.start) {
      throw TypeError('start must be a Number');
    }
    if (this.end === undefined) {
      this.end = Infinity;
    } else if ('number' !== typeof this.end) {
      throw TypeError('end must be a Number');
    }

    if (this.start > this.end) {
      throw new Error('start must be <= end');
    }

    this.pos = this.start;
  }

  if (this.fd !== null) {
    process.nextTick(function() {
      self._read();
    });
    return;
  }

  fs.open(this.path, this.flags, this.mode, function(err, fd) {
    if (err) {
      self.emit('error', err);
      self.readable = false;
      return;
    }

    self.fd = fd;
    self.emit('open', fd);
    self._read();
  });
};

util.inherits(ReadStream, Stream);

ReadStream.prototype.setEncoding = function(encoding) {
  var StringDecoder = require('string_decoder').StringDecoder; // lazy load
  this._decoder = new StringDecoder(encoding);
};

ReadStream.prototype._read = function() {
  var self = this;
  if (!this.readable || this.paused || this.reading) return;

  this.reading = true;

  if (!pool || pool.length - pool.used < kMinPoolSpace) {
    // discard the old pool. Can't add to the free list because
    // users might have refernces to slices on it.
    pool = null;
    allocNewPool();
  }

  // Grab another reference to the pool in the case that while we're in the
  // thread pool another read() finishes up the pool, and allocates a new
  // one.
  var thisPool = pool;
  var toRead = Math.min(pool.length - pool.used, ~~this.bufferSize);
  var start = pool.used;

  if (this.pos !== undefined) {
    toRead = Math.min(this.end - this.pos + 1, toRead);
  }

  function afterRead(err, bytesRead) {
    self.reading = false;

    if (self.stopEnd !== false) {
      if (err) {
        fs.close(self.fd, function() {
          self.fd = null;
          self.emit('error', err);
          self.readable = false;
        });
        return;
      }

      if (bytesRead === 0) {
        self.emit('end');
        self.destroy();
        return;
      }
    } else {
      if (err && !~err.message.indexOf('EAGAIN')) {
        fs.close(self.fd, function() {
          self.fd = null;
          self.emit('error', err);
          self.readable = false;
        });
        return;
      }
      // TODO: Use an IO watcher here instead of setTimeout.
      if (err || bytesRead === 0) {
        setTimeout(function() {
          self._read();
        }, 20);
        return;
      }
    }

    var b = thisPool.slice(start, start + bytesRead);

    // Possible optimizition here?
    // Reclaim some bytes if bytesRead < toRead?
    // Would need to ensure that pool === thisPool.

    // do not emit events if the stream is paused
    if (self.paused) {
      self.buffer = b;
      return;
    }

    // do not emit events anymore after we declared the stream unreadable
    if (!self.readable) return;

    self._emitData(b);
    self._read();
  }

  fs.read(this.fd, pool, pool.used, toRead, this.pos, afterRead);

  if (this.pos !== undefined) {
    this.pos += toRead;
  }
  pool.used += toRead;
};

ReadStream.prototype._emitData = function(d) {
  if (this._decoder) {
    var string = this._decoder.write(d);
    if (string.length) this.emit('data', string);
  } else {
    this.emit('data', d);
  }
};

ReadStream.prototype.destroy = function(cb) {
  var self = this;

  if (!this.readable) {
    if (cb) process.nextTick(function() { cb(null); });
    return;
  }
  this.readable = false;

  function close() {
    fs.close(self.fd, function(err) {
      if (err) {
        if (cb) cb(err);
        self.emit('error', err);
        return;
      }

      if (cb) cb(null);
      self.emit('close');
    });
  }

  if (this.fd === null) {
    this.addListener('open', close);
  } else {
    close();
  }
};

ReadStream.prototype.pause = function() {
  this.paused = true;
};

ReadStream.prototype.resume = function() {
  this.paused = false;

  if (this.buffer) {
    var buffer = this.buffer;
    this.buffer = null;
    this._emitData(buffer);
  }

  // hasn't opened yet.
  if (null == this.fd) return;

  this._read();
};
