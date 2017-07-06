/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';
import { inherits } from 'util';
import { Terminal } from './terminal';
import { WindowsPtyAgent } from './windowsPtyAgent';
import { IPtyForkOptions, IPtyOpenOptions } from './interfaces';
import { ArgvOrCommandLine } from './types';
import { assign } from './utils';

const DEFAULT_FILE = 'cmd.exe';
const DEFAULT_NAME = 'Windows Shell';

export class WindowsTerminal extends Terminal {
  private isReady: boolean;
  private deferreds: any[];
  private agent: WindowsPtyAgent;

  constructor(file?: string, args?: ArgvOrCommandLine, opt?: IPtyForkOptions) {
    super(opt);

    if (opt.encoding) {
      console.warn('Setting encoding on Windows is not supported');
    }

    // Initialize arguments
    args = args || [];
    file = file || DEFAULT_FILE;
    opt = opt || {};
    opt.env = opt.env || process.env;

    const env = assign({}, opt.env);
    const cols = opt.cols || Terminal.DEFAULT_COLS;
    const rows = opt.rows || Terminal.DEFAULT_ROWS;
    const cwd = opt.cwd || process.cwd();
    const name = opt.name || env.TERM || DEFAULT_NAME;
    const parsedEnv = this._parseEnv(env);

    // If the terminal is ready
    this.isReady = false;

    // Functions that need to run after `ready` event is emitted.
    this.deferreds = [];

    // Create new termal.
    this.agent = new WindowsPtyAgent(file, args, parsedEnv, cwd, cols, rows, false);
    this.socket = this.agent.outSocket;

    // Not available until `ready` event emitted.
    this.pid = this.agent.innerPid;
    this.fd = this.agent.fd;
    this.pty = this.agent.pty;

    // The forked windows terminal is not available until `ready` event is
    // emitted.
    this.socket.on('ready_datapipe', () => {

      // These events needs to be forwarded.
      ['connect', 'data', 'end', 'timeout', 'drain'].forEach(event => {
        this.socket.on(event, data => {

          // Wait until the first data event is fired then we can run deferreds.
          if (!this.isReady && event === 'data') {

            // Terminal is now ready and we can avoid having to defer method
            // calls.
            this.isReady = true;

            // Execute all deferred methods
            this.deferreds.forEach(fn => {
              // NB! In order to ensure that `this` has all its references
              // updated any variable that need to be available in `this` before
              // the deferred is run has to be declared above this forEach
              // statement.
              fn.run();
            });

            // Reset
            this.deferreds = [];

          }
        });
      });

      // Shutdown if `error` event is emitted.
      this.socket.on('error', err => {
        // Close terminal session.
        this._close();

        // EIO, happens when someone closes our child process: the only process
        // in the terminal.
        // node < 0.6.14: errno 5
        // node >= 0.6.14: read EIO
        if ((<any>err).code) {
          if (~(<any>err).code.indexOf('errno 5') || ~(<any>err).code.indexOf('EIO')) return;
        }

        // Throw anything else.
        if (this.listeners('error').length < 2) {
          throw err;
        }
      });

      // Cleanup after the socket is closed.
      this.socket.on('close', () => {
        this.emit('exit', null);
        this._close();
      });

    });

    this.file = file;
    this.name = name;

    this.readable = true;
    this.writable = true;
  }

  /**
   * openpty
   */

  public static open(options?: IPtyOpenOptions): void {
    throw new Error('open() not supported on windows, use Fork() instead.');
  }

  /**
   * Events
   */

  public write(data: string): void {
    this._defer(() => {
      this.agent.inSocket.write(data);
    });
  }

  /**
   * TTY
   */

  public resize(cols: number, rows: number): void {
    this._defer(() => {
      this.agent.resize(cols, rows);
    });
  }

  public destroy(): void {
    this._defer(() => {
      this.kill();
    });
  }

  public kill(signal?: string): void {
    this._defer(() => {
      if (signal) {
        throw new Error('Signals not supported on windows.');
      }
      this._close();
      this.agent.kill();
    });
  }

  private _defer(deferredFn: Function): void {

    // Ensure that this method is only used within Terminal class.
    if (!(this instanceof WindowsTerminal)) {
      throw new Error('Must be instanceof WindowsTerminal');
    }

    // If the terminal is ready, execute.
    if (this.isReady) {
      deferredFn.apply(this, null);
      return;
    }

    // Queue until terminal is ready.
    this.deferreds.push({
      run: () => deferredFn.apply(this, null)
    });
  }

  /**
   * Gets the name of the process.
   */
  public get process(): string { return this.name; }
}
