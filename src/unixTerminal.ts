/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as extend from 'extend';
import * as net from 'net';
import * as path from 'path';
import * as tty from 'tty';
import { Terminal } from './terminal';

let pty;
try {
  pty = require(path.join('..', 'build', 'Release', 'pty.node'));
} catch (e) {
  pty = require(path.join('..', 'build', 'Debug', 'pty.node'));
};

const version = process.versions.node.split('.').map(function(n) {
  return +(n + '').split('-')[0];
});

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

    const self = this;
    let env
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

    cols = opt.cols || Terminal.DEFAULT_COLS;
    rows = opt.rows || Terminal.DEFAULT_ROWS;

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

    this.socket = new PipeSocket(term.fd);
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
    const self = this;
    opt = opt || {};

    if (arguments.length > 1) {
      opt = {
        cols: arguments[1],
        rows: arguments[2]
      };
    }

    let cols = opt.cols || Terminal.DEFAULT_COLS
      , rows = opt.rows || Terminal.DEFAULT_ROWS
      , term;

    // open
    term = pty.open(cols, rows);

    self.master = new PipeSocket(term.master);
    self.master.setEncoding('utf8');
    self.master.resume();

    self.slave = new PipeSocket(term.slave);
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

  public write(data) {
    return this.socket.write(data);
  }

  public destroy() {
    const self = this;

    // close
    this._close();

    // Need to close the read stream so
    // node stops reading a dead file descriptor.
    // Then we can safely SIGHUP the shell.
    this.socket.once('close', function() {
      self.kill('SIGHUP');
    });

    this.socket.destroy();
  }

  public kill(sig) {
    try {
      process.kill(this.pid, sig || 'SIGHUP');
    } catch (e) { /* swallow */ }
  }

  public get process() {
    return pty.process(this.fd, this.pty) || this.file;
  }

  /**
   * TTY
   */

  public resize(cols, rows) {
    cols = cols || Terminal.DEFAULT_COLS;
    rows = rows || Terminal.DEFAULT_ROWS;

    this.cols = cols;
    this.rows = rows;

    pty.resize(this.fd, cols, rows);
  }
}

/**
 * Wraps net.Socket to force the handle type "PIPE" by temporarily overwriting
 * tty_wrap.guessHandleType.
 * See: https://github.com/chjj/pty.js/issues/103
 */
class PipeSocket extends net.Socket {
  constructor(fd) {
    const tty = (<any>process).binding('tty_wrap');
    const guessHandleType = tty.guessHandleType;
    tty.guessHandleType = function() {
      return 'PIPE';
    };
    super({ fd });
    tty.guessHandleType = guessHandleType;
  }
}
