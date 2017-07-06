/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';
import * as tty from 'tty';
import { Terminal } from './terminal';
import { ProcessEnv, IPtyForkOptions, IPtyOpenOptions } from './interfaces';
import { ArgvOrCommandLine } from './types';
import { assign } from './utils';

const pty = require(path.join('..', 'build', 'Release', 'pty.node'));

const DEFAULT_FILE = 'sh';
const DEFAULT_NAME = 'xterm';

export class UnixTerminal extends Terminal {
  protected pid: number;
  protected fd: number;
  protected pty: any;

  protected file: string;
  protected name: string;

  protected readable: boolean;
  protected writable: boolean;

  private _boundClose: boolean;
  private _emittedClose: boolean;
  private master: any;
  private slave: any;

  constructor(file?: string, args?: ArgvOrCommandLine, opt?: IPtyForkOptions) {
    super(opt);

    if (typeof args === 'string') {
      throw new Error('args as a string is not supported on unix.');
    }

    // Initialize arguments
    args = args || [];
    file = file || DEFAULT_FILE;
    opt = opt || {};
    opt.env = opt.env || process.env;

    const cols = opt.cols || Terminal.DEFAULT_COLS;
    const rows = opt.rows || Terminal.DEFAULT_ROWS;
    const uid = opt.uid || -1;
    const gid = opt.gid || -1;
    const env = assign({}, opt.env);

    if (opt.env === process.env) {
      this._sanitizeEnv(env);
    }

    const cwd = opt.cwd || process.cwd();
    const name = opt.name || env.TERM || DEFAULT_NAME;
    env.TERM = name;
    const parsedEnv = this._parseEnv(env);

    const encoding = (opt.encoding === undefined ? 'utf8' : opt.encoding);

    const onexit = (code: any, signal: any) => {
      // XXX Sometimes a data event is emitted after exit. Wait til socket is
      // destroyed.
      if (!this._emittedClose) {
        if (this._boundClose) return;
        this._boundClose = true;
        this.once('close', () => this.emit('exit', code, signal));
        return;
      }
      this.emit('exit', code, signal);
    };

    // fork
    const term = pty.fork(file, args, parsedEnv, cwd, cols, rows, uid, gid, (encoding === 'utf8'), onexit);

    this.socket = new PipeSocket(term.fd);
    if (encoding !== null) {
      this.socket.setEncoding(encoding);
    }

    // setup
    this.socket.on('error', (err: any) => {
      // NOTE: fs.ReadStream gets EAGAIN twice at first:
      if (err.code) {
        if (~err.code.indexOf('EAGAIN')) {
          return;
        }
      }

      // close
      this._close();
      // EIO on exit from fs.ReadStream:
      if (!this._emittedClose) {
        this._emittedClose = true;
        this.emit('close');
      }

      // EIO, happens when someone closes our child process: the only process in
      // the terminal.
      // node < 0.6.14: errno 5
      // node >= 0.6.14: read EIO
      if (err.code) {
        if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) {
          return;
        }
      }

      // throw anything else
      if (this.listeners('error').length < 2) {
        throw err;
      }
    });

    this.pid = term.pid;
    this.fd = term.fd;
    this.pty = term.pty;

    this.file = file;
    this.name = name;

    this.readable = true;
    this.writable = true;

    this.socket.on('close', () => {
      if (this._emittedClose) {
        return;
      }
      this._emittedClose = true;
      this._close();
      this.emit('close');
    });
  }

  /**
   * openpty
   */

  public static open(opt: IPtyOpenOptions): UnixTerminal {
    const self = Object.create(UnixTerminal.prototype);
    opt = opt || {};

    if (arguments.length > 1) {
      opt = {
        cols: arguments[1],
        rows: arguments[2]
      };
    }

    const cols = opt.cols || Terminal.DEFAULT_COLS;
    const rows = opt.rows || Terminal.DEFAULT_ROWS;
    const encoding = opt.encoding ? 'utf8' : opt.encoding;

    // open
    const term = pty.open(cols, rows);

    self.master = new PipeSocket(term.master);
    self.master.setEncoding(encoding);
    self.master.resume();

    self.slave = new PipeSocket(term.slave);
    self.slave.setEncoding(encoding);
    self.slave.resume();

    self.socket = self.master;
    self.pid = null;
    self.fd = term.master;
    self.pty = term.pty;

    self.file = process.argv[0] || 'node';
    self.name = process.env.TERM || '';

    self.readable = true;
    self.writable = true;

    self.socket.on('error', err => {
      self._close();
      if (self.listeners('error').length < 2) {
        throw err;
      }
    });

    self.socket.on('close', () => {
      self._close();
    });

    return self;
  };

  public write(data: string): void {
    this.socket.write(data);
  }

  public destroy(): void {
    this._close();

    // Need to close the read stream so node stops reading a dead file
    // descriptor. Then we can safely SIGHUP the shell.
    this.socket.once('close', () => {
      this.kill('SIGHUP');
    });

    this.socket.destroy();
  }

  public kill(signal?: string): void {
    try {
      process.kill(this.pid, signal || 'SIGHUP');
    } catch (e) { /* swallow */ }
  }

  /**
   * Gets the name of the process.
   */
  public get process(): string {
    return pty.process(this.fd, this.pty) || this.file;
  }

  /**
   * TTY
   */

  public resize(cols: number, rows: number): void {
    pty.resize(this.fd, cols, rows);
  }

  private _sanitizeEnv(env: ProcessEnv): void {
      // Make sure we didn't start our server from inside tmux.
      delete env['TMUX'];
      delete env['TMUX_PANE'];

      // Make sure we didn't start our server from inside screen.
      // http://web.mit.edu/gnu/doc/html/screen_20.html
      delete env['STY'];
      delete env['WINDOW'];

      // Delete some variables that might confuse our terminal.
      delete env['WINDOWID'];
      delete env['TERMCAP'];
      delete env['COLUMNS'];
      delete env['LINES'];
  }
}

/**
 * Wraps net.Socket to force the handle type "PIPE" by temporarily overwriting
 * tty_wrap.guessHandleType.
 * See: https://github.com/chjj/pty.js/issues/103
 */
class PipeSocket extends net.Socket {
  constructor(fd: any) {
    const tty = (<any>process).binding('tty_wrap');
    const guessHandleType = tty.guessHandleType;
    tty.guessHandleType = () => 'PIPE';
    super({ fd });
    tty.guessHandleType = guessHandleType;
  }
}
