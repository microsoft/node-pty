/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Binding to the pseudo terminals.
 */

import { Terminal } from './terminal';

var extend = require('extend');
var EventEmitter = require('events').EventEmitter;
var net = require('net');
var tty = require('tty');
var path = require('path');
var nextTick = global.setImmediate || process.nextTick;
var pty;
try {
  pty = require(path.join('..', 'build', 'Release', 'pty.node'));
} catch(e) {
  console.warn('Using debug version');
  pty = require(path.join('..', 'build', 'Debug', 'pty.node'));
};

var version = process.versions.node.split('.').map(function(n) {
  return +(n + '').split('-')[0];
});

var DEFAULT_COLS = 80;
var DEFAULT_ROWS = 24;


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

export class UnixTerminal extends Terminal {
  protected socket: any;
  protected pid: number;
  protected fd: number;
  protected pty: any;

  protected file: string;
  protected name: string;
  protected cols: number;
  protected rows: number;

  protected readable: boolean;
  protected writable: boolean;

  private _boundClose: boolean;
  private _emittedClose: boolean;
  private master: any;
  private slave: any;

  constructor(file, args, opt) {
    super();

    if (!(this instanceof UnixTerminal)) {
      return new UnixTerminal(file, args, opt);
    }

    var self = this
      , env
      , cwd
      , name
      , cols
      , rows
      , uid
      , gid
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

    cols = opt.cols || DEFAULT_COLS;
    rows = opt.rows || DEFAULT_ROWS;

    uid = opt.uid != null ? opt.uid : -1;
    gid = opt.gid != null ? opt.gid : -1;

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
    // XXX Shouldn't be necessary:
    // env.LINES = rows + '';
    // env.COLUMNS = cols + '';

    env = this._parseEnv(env);

    function onexit(code, signal) {
      // XXX Sometimes a data event is emitted
      // after exit. Wait til socket is destroyed.
      if (!self._emittedClose) {
        if (self._boundClose) return;
        self._boundClose = true;
        self.once('close', function() {
          self.emit('exit', code, signal);
        });
        return;
      }
      self.emit('exit', code, signal);
    }

    // fork
    term = pty.fork(file, args, env, cwd, cols, rows, uid, gid, onexit);

    this.socket = TTYStream(term.fd);
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
      if (!self._emittedClose) {
        self._emittedClose = true;
        self.emit('close');
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

    this.socket.on('close', function() {
      if (self._emittedClose) return;
      self._emittedClose = true;
      self._close();
      self.emit('close');
    });

    env = null;
  }

  /**
   * openpty
   */

  public open(opt) {
    var self = this;
    opt = opt || {};

    if (arguments.length > 1) {
      opt = {
        cols: arguments[1],
        rows: arguments[2]
      };
    }

    var cols = opt.cols || DEFAULT_COLS
      , rows = opt.rows || DEFAULT_ROWS
      , term;

    // open
    term = pty.open(cols, rows);

    self.master = TTYStream(term.master);
    self.master.setEncoding('utf8');
    self.master.resume();

    self.slave = TTYStream(term.slave);
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
      self._close();
      if (self.listeners('error').length < 2) {
        throw err;
      }
    });

    self.socket.on('close', function() {
      self._close();
    });

    return self;
  };

  /**
   * TTY
   */

  public resize(cols, rows) {
    cols = cols || DEFAULT_COLS;
    rows = rows || DEFAULT_ROWS;

    this.cols = cols;
    this.rows = rows;

    pty.resize(this.fd, cols, rows);
  }
}

/**
 * TTY Stream
 */

function TTYStream(fd) {
  // Could use: if (!require('tty').ReadStream)
  if (version[0] === 0 && version[1] < 7) {
    return new net.Socket(fd);
  }

  if (version[0] === 0 && version[1] < 12) {
    return new tty.ReadStream(fd);
  }

  return new Socket(fd);
}

/**
 * Wrap net.Socket for a workaround
 */

function Socket(options): void {
  if (!(this instanceof Socket)) {
    return new Socket(options);
  }
  // TODO: Why doesn't binding exist according to TS?
  var tty = (<any>process).binding('tty_wrap');
  var guessHandleType = tty.guessHandleType;
  tty.guessHandleType = function() {
    return 'PIPE';
  };
  net.Socket.call(this, options);
  tty.guessHandleType = guessHandleType;
}

Socket.prototype.__proto__ = net.Socket.prototype;
