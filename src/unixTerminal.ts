/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */
import * as net from 'net';
import * as path from 'path';
import { Terminal, DEFAULT_COLS, DEFAULT_ROWS } from './terminal';
import { IProcessEnv, IPtyForkOptions, IPtyOpenOptions } from './interfaces';
import { ArgvOrCommandLine } from './types';
import { assign, loadNativeModule } from './utils';

const native = loadNativeModule('pty');
const pty: IUnixNative = native.module;
let helperPath = native.dir + '/spawn-helper';
helperPath = path.resolve(__dirname, helperPath);
helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');

const DEFAULT_FILE = 'sh';
const DEFAULT_NAME = 'xterm';
const DESTROY_SOCKET_TIMEOUT_MS = 200;

type SocketConstructor = new (fd: number) => net.Socket;

// libuv (and by extension node.js) have a limitation where they check the type
// handle and if it's a TTY one assume that it must be a TTY client (not host).
// Because of this, they set UV_HANDLE_BLOCKING_WRITES on the libuv stream.
// This in turn means that on EAGAIN, it'll retry the write synchronously.
// This can cause deadlocks under macOS when its PTY pipe is full.
//
// To fix this, we use a hack to create a custom uv_pipe_t handle using pipe_wrap.
// If that fails, we fall back to tty.ReadStream but with a custom write function.
// The fallback is not ideal, because without poll() we can only use setTimeout.
//
// eslint-disable-next-line @typescript-eslint/naming-convention
const Socket: SocketConstructor = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const { Pipe, constants: PipeConstants } = (process as any).binding('pipe_wrap');
    const SOCKET = PipeConstants.SOCKET;

    if (typeof Pipe === 'function' && typeof SOCKET === 'number') {
      return class PipeSocket extends net.Socket {
        constructor(fd: number) {
          if (fd >> 0 !== fd || fd < 0) {
            throw new Error(`Invalid file descriptor: ${fd}`);
          }

          const handle = new Pipe(SOCKET);
          handle.open(fd);

          super(<any>{
            handle,
            manualStart: true
          });
        }
      };
    }
  } catch (e) {
  }

  console.warn('node-pty: falling back to tty.ReadStream');

  const fs: typeof import('fs') = require('fs');
  const tty: typeof import('tty') = require('tty');

  interface IWriteTask {
    data: Buffer;
    offset: number;
  }

  return class TtySocket extends tty.ReadStream {
    private readonly _fd: number;
    private _encoding?: BufferEncoding = undefined;
    private _writeQueue: IWriteTask[] = [];
    private _timeout: NodeJS.Timeout | undefined;

    constructor(fd: number) {
      super(fd);
      this._fd = fd;
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    public _destroy(error: Error | null, callback: (error: Error | null) => void): void {
      if (this._timeout !== undefined) {
        clearTimeout(this._timeout);
        this._timeout = undefined;
      }
      return super._destroy(error, callback);
    }

    public setEncoding(encoding: BufferEncoding): this {
      this._encoding = encoding;
      return super.setEncoding(encoding);
    }

    public write(str: string | Buffer): boolean {
      const data = typeof str === 'string'
        ? Buffer.from(str, this._encoding)
        : Buffer.from(str);

      if (data.byteLength !== 0) {
        this._writeQueue.push({ data, offset: 0 });
        if (this._writeQueue.length === 1) {
          this._processQueue();
        }
      }

      return true;
    }

    private _processQueue(): void {
      if (this._writeQueue.length === 0) {
        return;
      }

      const task = this._writeQueue[0];
      fs.write(this._fd, task.data, task.offset, (err, written) => {
        if (err) {
          if ((err as any).code === 'EAGAIN') {
            this._timeout = setTimeout(() => this._processQueue(), 5);
          } else {
            this._writeQueue = [];
            this.emit('error', err);
          }
          return;
        }

        task.offset += written;
        if (task.offset >= task.data.byteLength) {
          this._writeQueue.shift();
        }

        this._processQueue();
      });
    }
  };
})();

export class UnixTerminal extends Terminal {
  protected _fd: number;
  protected _pty: string;

  protected _file: string;
  protected _name: string;

  protected _readable: boolean;
  protected _writable: boolean;

  private _boundClose: boolean = false;
  private _emittedClose: boolean = false;
  private _master: net.Socket | undefined;
  private _slave: net.Socket | undefined;

  public get master(): net.Socket | undefined { return this._master; }
  public get slave(): net.Socket | undefined { return this._slave; }

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

    this._cols = opt.cols || DEFAULT_COLS;
    this._rows = opt.rows || DEFAULT_ROWS;
    const uid = opt.uid ?? -1;
    const gid = opt.gid ?? -1;
    const env: IProcessEnv = assign({}, opt.env);

    if (opt.env === process.env) {
      this._sanitizeEnv(env);
    }

    const cwd = opt.cwd || process.cwd();
    env.PWD = cwd;
    const name = opt.name || env.TERM || DEFAULT_NAME;
    env.TERM = name;
    const parsedEnv = this._parseEnv(env);

    const encoding = (opt.encoding === undefined ? 'utf8' : opt.encoding);

    const onexit = (code: number, signal: number): void => {
      // XXX Sometimes a data event is emitted after exit. Wait til socket is
      // destroyed.
      if (!this._emittedClose) {
        if (this._boundClose) {
          return;
        }
        this._boundClose = true;
        // From macOS High Sierra 10.13.2 sometimes the socket never gets
        // closed. A timeout is applied here to avoid the terminal never being
        // destroyed when this occurs.
        let timeout: NodeJS.Timeout | null = setTimeout(() => {
          timeout = null;
          // Destroying the socket now will cause the close event to fire
          this._socket.destroy();
        }, DESTROY_SOCKET_TIMEOUT_MS);
        this.once('close', () => {
          if (timeout !== null) {
            clearTimeout(timeout);
          }
          this.emit('exit', code, signal);
        });
        return;
      }
      this.emit('exit', code, signal);
    };

    // fork
    const term = pty.fork(file, args, parsedEnv, cwd, this._cols, this._rows, uid, gid, (encoding === 'utf8'), helperPath, onexit);

    this._socket = new Socket(term.fd);
    if (encoding !== null) {
      this._socket.setEncoding(encoding);
    }

    // setup
    this._socket.on('error', (err: any) => {
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

    this._pid = term.pid;
    this._fd = term.fd;
    this._pty = term.pty;

    this._file = file;
    this._name = name;

    this._readable = true;
    this._writable = true;

    this._socket.on('close', () => {
      if (this._emittedClose) {
        return;
      }
      this._emittedClose = true;
      this._close();
      this.emit('close');
    });

    this._forwardEvents();
  }

  protected _write(data: string | Buffer): void {
    this._socket.write(data);
  }

  /* Accessors */
  get fd(): number { return this._fd; }
  get ptsName(): string { return this._pty; }

  /**
   * openpty
   */

  public static open(opt: IPtyOpenOptions): UnixTerminal {
    const self: UnixTerminal = Object.create(UnixTerminal.prototype);
    opt = opt || {};

    if (arguments.length > 1) {
      opt = {
        cols: arguments[1],
        rows: arguments[2]
      };
    }

    const cols = opt.cols || DEFAULT_COLS;
    const rows = opt.rows || DEFAULT_ROWS;
    const encoding = (opt.encoding === undefined ? 'utf8' : opt.encoding);

    // open
    const term: IUnixOpenProcess = pty.open(cols, rows);

    self._master = new Socket(term.master);
    if (encoding !== null) {
      self._master.setEncoding(encoding);
    }
    self._master.resume();

    self._slave = new Socket(term.slave);
    if (encoding !== null) {
      self._slave.setEncoding(encoding);
    }
    self._slave.resume();

    self._socket = self._master;
    self._pid = -1;
    self._fd = term.master;
    self._pty = term.pty;

    self._file = process.argv[0] || 'node';
    self._name = process.env.TERM || '';

    self._readable = true;
    self._writable = true;

    self._socket.on('error', err => {
      self._close();
      if (self.listeners('error').length < 2) {
        throw err;
      }
    });

    self._socket.on('close', () => {
      self._close();
    });

    return self;
  }

  public destroy(): void {
    this._close();

    // Need to close the read stream so node stops reading a dead file
    // descriptor. Then we can safely SIGHUP the shell.
    this._socket.once('close', () => {
      this.kill('SIGHUP');
    });

    this._socket.destroy();
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
    if (process.platform === 'darwin') {
      const title = pty.process(this._fd);
      return (title !== 'kernel_task') ? title : this._file;
    }

    return pty.process(this._fd, this._pty) || this._file;
  }

  /**
   * TTY
   */

  public resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || isNaN(cols) || isNaN(rows) || cols === Infinity || rows === Infinity) {
      throw new Error('resizing must be done using positive cols and rows');
    }
    pty.resize(this._fd, cols, rows);
    this._cols = cols;
    this._rows = rows;
  }

  public clear(): void {

  }

  private _sanitizeEnv(env: IProcessEnv): void {
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
