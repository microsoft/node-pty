/**
 * pty.js
 * Copyright (c) 2012, Christopher Jeffrey (MIT License)
 * Binding to the pseudo terminals.
 */

var extend = require('extend');
var pty = require('../build/Release/pty.node');

/**
 * TTY Stream
 */

function TTYStream(fd) {
  var self = this;
  var version = process.versions.node.split('.');

  // // if (!require('tty').ReadStream) {
  // if (+version[0] === 0 && +version[1] < 7) {
  //   var net = require('net');
  //   this.socket = new net.Socket(fd);
  //   return this;
  // }

  if (+version[0] === 0 && +version[1] < 12) {
    var tty = require('tty');
    this.socket = new tty.ReadStream(fd);
    return this;
  }

  var fs = require('fs');
  var stream = require('./stream');

  this.input = new fs.WriteStream(null, {
    fd: fd
  });
  this.output = new stream.ReadStream(null, {
    fd: fd,
    autoClose: false,
    stopEnd: false
  });

  // XXX Horrible workaround because fs.ReadStream stops reading.
  // Cannot .unref() this.
  // setInterval(function() {
  //   self.output._read(self.output._readableState.highWaterMark);
  // }, 20);

  this.readable = true;
  this.writable = true;

  this.input.on('finish', function() {
    self.emit('close');
  });

  this.output.on('finish', function() {
    self.emit('close');
  });

  this.input.on('end', function() {
    self.emit('close');
  });

  this.output.on('end', function() {
    self.emit('close');
  });
}

TTYStream.prototype.write = function(data) {
  if (this.socket) return this.socket.write(data);
  return this.input.write(data);
};

TTYStream.prototype.end = function(data) {
  if (this.socket) return this.socket.end(data);
  return this.input.end(data);
};

TTYStream.prototype.pipe = function(dest, options) {
  if (this.socket) return this.socket.pipe(dest, options);
  return this.output.pipe(dest, options);
};

TTYStream.prototype.pause = function() {
  if (this.socket) return this.socket.pause();
  return this.output.pause();
};

TTYStream.prototype.resume = function() {
  if (this.socket) return this.socket.resume();
  return this.output.resume();
};

TTYStream.prototype.setEncoding = function(enc) {
  if (this.socket) {
    if (this.socket._decoder) {
      delete this.socket._decoder;
    }
    if (enc) {
      return this.socket.setEncoding(enc);
    }
    return;
  }
  if (this.output._decoder) {
    delete this.output._decoder;
  }
  if (enc) {
    return this.output.setEncoding(enc);
  }
};

TTYStream.prototype.addListener =
TTYStream.prototype.on = function(type, func) {
  if (this.socket) return this.socket.on(type, func);
  this.input.on(type, func);
  return this.output.on(type, func);
};

TTYStream.prototype.emit = function() {
  if (this.socket) return this.socket.emit.apply(this.socket, arguments);
  this.input.emit.apply(this.input, arguments);
  return this.output.emit.apply(this.output, arguments);
};

TTYStream.prototype.listeners = function(type) {
  if (this.socket) return this.socket.listeners(type);
  var a1 = this.input.listeners(type);
  var a2 = this.output.listeners(type);
  return a1.concat(a2);
};

TTYStream.prototype.removeListener = function(type, func) {
  if (this.socket) return this.socket.removeListener(type, func);
  this.input.removeListener(type, func);
  return this.output.removeListener(type, func);
};

TTYStream.prototype.removeAllListeners = function(type) {
  if (this.socket) return this.socket.removeAllListeners(type);
  this.input.removeAllListeners(type);
  return this.output.removeAllListeners(type);
};

TTYStream.prototype.once = function(type, func) {
  if (this.socket) return this.socket.once(type, func);
  this.input.once(type, func);
  return this.output.once(type, func);
};

TTYStream.prototype.close = function() {
  try {
    if (this.socket) return this.socket.close();
    this.input.close();
    return this.output.close();
  } catch (e) {
    ;
  }
};

TTYStream.prototype.destroy = function() {
  try {
    if (this.socket) return this.socket.destroy();
    this.input.destroy();
    return this.output.destroy();
  } catch (e) {
    ;
  }
};

/**
 * Terminal
 */

// Example:
//  var term = new Terminal('bash', [], {
//    name: 'xterm-color',
//    cols: 80,
//    rows: 24,
//    cwd: process.env.HOME,
//    env: process.env
//  });

function Terminal(file, args, opt) {
  if (!(this instanceof Terminal)) {
    return new Terminal(file, args, opt);
  }

  var self = this
    , env
    , cwd
    , name
    , cols
    , rows
    , term;

  // backward compatibility
  if (typeof args === 'string') {
    opt = {
      name: arguments[1],
      cols: arguments[2],
      rows: arguments[3],
      cwd: process.env.HOME
    };
    args = [];
  }

  // arguments
  args = args || [];
  file = file || 'sh';
  opt = opt || {};

  cols = opt.cols || 80;
  rows = opt.rows || 24;

  opt.env = opt.env || process.env;
  env = extend({}, opt.env);

  if (opt.env === process.env) {
    // Make sure we didn't start our
    // server from inside tmux.
    delete env.TMUX;
    delete env.TMUX_PANE;

    // Make sure we didn't start
    // our server from inside screen.
    // http://web.mit.edu/gnu/doc/html/screen_20.html
    delete env.STY;
    delete env.WINDOW;

    // Delete some variables that
    // might confuse our terminal.
    delete env.WINDOWID;
    delete env.TERMCAP;
    delete env.COLUMNS;
    delete env.LINES;
  }

  // Could set some basic env vars
  // here, if they do not exist:
  // USER, SHELL, HOME, LOGNAME, WINDOWID

  cwd = opt.cwd || process.cwd();
  name = opt.name || env.TERM || 'xterm';
  env.TERM = name;
  env.LINES = rows + '';
  env.COLUMNS = cols + '';

  env = environ(env);

  // fork
  term = opt.uid && opt.gid
    ? pty.fork(file, args, env, cwd, cols, rows, opt.uid, opt.gid)
    : pty.fork(file, args, env, cwd, cols, rows);

  this.socket = new TTYStream(term.fd);
  this.socket.setEncoding('utf8');
  this.socket.resume();

  // setup
  this.socket.on('error', function(err) {
    // NOTE: fs.ReadStream gets EAGAIN twice at first:
    if (err.code) {
      if (~err.code.indexOf('EAGAIN')) return;
    }

    // close
    self._close();
    // EIO on exit from fs.ReadStream:
    if (!self._emittedExit) {
      self._emittedExit = true;
      Terminal.total--;
      self.emit('exit', null);
    }

    // EIO, happens when someone closes our child
    // process: the only process in the terminal.
    // node < 0.6.14: errno 5
    // node >= 0.6.14: read EIO
    if (err.code) {
      if (~err.code.indexOf('errno 5')
          || ~err.code.indexOf('EIO')) return;
    }

    // throw anything else
    if (self.listeners('error').length < 2) {
      throw err;
    }
  });

  this.pid = term.pid;
  this.fd = term.fd;
  this.pty = term.pty;

  this.file = file;
  this.name = name;
  this.cols = cols;
  this.rows = rows;

  this.readable = true;
  this.writable = true;

  Terminal.total++;
  // XXX This never gets emitted with v0.12.0
  this.socket.on('close', function() {
    if (self._emittedExit) return;
    self._emittedExit = true;
    Terminal.total--;
    self._close();
    self.emit('exit', null);
  });

  env = null;
}

Terminal.fork =
Terminal.spawn =
Terminal.createTerminal = function(file, args, opt) {
  return new Terminal(file, args, opt);
};

/**
 * openpty
 */

Terminal.open = function(opt) {
  var self = Object.create(Terminal.prototype)
    , opt = opt || {};

  if (arguments.length > 1) {
    opt = {
      cols: arguments[1],
      rows: arguments[2]
    };
  }

  var cols = opt.cols || 80
    , rows = opt.rows || 24
    , term;

  // open
  term = pty.open(cols, rows);

  self.master = new TTYStream(term.master);
  self.master.setEncoding('utf8');
  self.master.resume();

  self.slave = new TTYStream(term.slave);
  self.slave.setEncoding('utf8');
  self.slave.resume();

  self.socket = self.master;
  self.pid = null;
  self.fd = term.master;
  self.pty = term.pty;

  self.file = process.argv[0] || 'node';
  self.name = process.env.TERM || '';
  self.cols = cols;
  self.rows = rows;

  self.readable = true;
  self.writable = true;

  self.socket.on('error', function(err) {
    Terminal.total--;
    self._close();
    if (self.listeners('error').length < 2) {
      throw err;
    }
  });

  Terminal.total++;
  self.socket.on('close', function() {
    Terminal.total--;
    self._close();
  });

  return self;
};

/**
 * Total
 */

// Keep track of the total
// number of terminals for
// the process.
Terminal.total = 0;

/**
 * Events
 */

Terminal.prototype.write = function(data) {
  return this.socket.write(data);
};

Terminal.prototype.end = function(data) {
  return this.socket.end(data);
};

Terminal.prototype.pipe = function(dest, options) {
  return this.socket.pipe(dest, options);
};

Terminal.prototype.pause = function() {
  return this.socket.pause();
};

Terminal.prototype.resume = function() {
  return this.socket.resume();
};

Terminal.prototype.setEncoding = function(enc) {
  if (this.socket._decoder) {
    delete this.socket._decoder;
  }
  if (enc) {
    this.socket.setEncoding(enc);
  }
};

Terminal.prototype.addListener =
Terminal.prototype.on = function(type, func) {
  this.socket.on(type, func);
  return this;
};

Terminal.prototype.emit = function() {
  return this.socket.emit.apply(this.socket, arguments);
};

Terminal.prototype.listeners = function(type) {
  return this.socket.listeners(type);
};

Terminal.prototype.removeListener = function(type, func) {
  this.socket.removeListener(type, func);
  return this;
};

Terminal.prototype.removeAllListeners = function(type) {
  this.socket.removeAllListeners(type);
  return this;
};

Terminal.prototype.once = function(type, func) {
  this.socket.once(type, func);
  return this;
};

Terminal.prototype.__defineGetter__('stdin', function() {
  return this;
});

Terminal.prototype.__defineGetter__('stdout', function() {
  return this;
});

Terminal.prototype.__defineGetter__('stderr', function() {
  throw new Error('No stderr.');
});

/**
 * TTY
 */

Terminal.prototype.resize = function(cols, rows) {
  cols = cols || 80;
  rows = rows || 24;

  this.cols = cols;
  this.rows = rows;

  pty.resize(this.fd, cols, rows);
};

Terminal.prototype.destroy = function() {
  var self = this;

  // close
  this._close();

  // Need to close the read stream so
  // node stops reading a dead file descriptor.
  // Then we can safely SIGHUP the shell.
  this.socket.once('close', function() {
    self.kill('SIGHUP');
  });

  this.socket.destroy();
};

Terminal.prototype.kill = function(sig) {
  try {
    process.kill(this.pid, sig || 'SIGHUP');
  } catch(e) {
    ;
  }
};

Terminal.prototype.redraw = function() {
  var self = this
    , cols = this.cols
    , rows = this.rows;

  // We could just send SIGWINCH, but most programs will
  // ignore it if the size hasn't actually changed.

  this.resize(cols + 1, rows + 1);

  setTimeout(function() {
    self.resize(cols, rows);
  }, 30);
};

Terminal.prototype.__defineGetter__('process', function() {
  return pty.process(this.fd, this.pty) || this.file;
});

Terminal.prototype._close = function() {
  this.socket.writable = false;
  this.socket.readable = false;
  this.write = function() {};
  this.end = function() {};
  this.writable = false;
  this.readable = false;
};

/**
 * Helpers
 */

function environ(env) {
  var keys = Object.keys(env || {})
    , l = keys.length
    , i = 0
    , pairs = [];

  for (; i < l; i++) {
    pairs.push(keys[i] + '=' + env[keys[i]]);
  }

  return pairs;
}

/**
 * Expose
 */

module.exports = exports = Terminal;
exports.Terminal = Terminal;
exports.native = pty;
