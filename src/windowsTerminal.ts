/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';
import * as extend from 'extend';
import { inherits } from 'util';
import { Terminal } from './terminal';
import { WindowsPtyAgent } from './windowsPtyAgent';
import { IPtyForkOptions, IPtyOpenOptions } from './interfaces';

let pty;
try {
  pty = require(path.join('..', 'build', 'Release', 'pty.node'));
} catch (e) {
  pty = require(path.join('..', 'build', 'Debug', 'pty.node'));
};

export class WindowsTerminal extends Terminal {
  private isReady: boolean;
  private deferreds: any[];
  private agent: any;
  private dataPipe: any;

  constructor(file?: string, args?: string[], opt?: IPtyForkOptions) {
    super();

    let env, cwd, name, cols, rows, term, agent;

    // Arguments.
    args = args || [];
    file = file || 'cmd.exe';
    opt = opt || {};

    opt.env = opt.env || process.env;
    env = extend({}, opt.env);

    cols = opt.cols || Terminal.DEFAULT_COLS;
    rows = opt.rows || Terminal.DEFAULT_ROWS;
    cwd = opt.cwd || process.cwd();
    name = opt.name || env.TERM || 'Windows Shell';

    env.TERM = name;

    // Initialize environment variables.
    env = this._parseEnv(env);

    // If the terminal is ready
    this.isReady = false;

    // Functions that need to run after `ready` event is emitted.
    this.deferreds = [];

    // Create new termal.
    this.agent = new WindowsPtyAgent(file, args, env, cwd, cols, rows, false);

    // The dummy socket is used so that we can defer everything
    // until its available.
    this.socket = this.agent.ptyOutSocket;

    // The terminal socket when its available
    this.dataPipe = null;

    // Not available until `ready` event emitted.
    this.pid = this.agent.pid;
    this.fd = this.agent.fd;
    this.pty = this.agent.pty;

    // The forked windows terminal is not available
    // until `ready` event is emitted.
    this.socket.on('ready_datapipe', () => {

      // These events needs to be forwarded.
      ['connect', 'data', 'end', 'timeout', 'drain'].forEach(event => {
        this.socket.on(event, data => {

          // Wait until the first data event is fired
          // then we can run deferreds.
          if (!this.isReady && event === 'data') {

            // Terminal is now ready and we can
            // avoid having to defer method calls.
            this.isReady = true;

            // Execute all deferred methods
            this.deferreds.forEach(fn => {
              // NB! In order to ensure that `this` has all
              // its references updated any variable that
              // need to be available in `this` before
              // the deferred is run has to be declared
              // above this forEach statement.
              fn.run();
            });

            // Reset
            this.deferreds = [];

          }
        });
      });

      // Resume socket.
      this.socket.resume();

      // Shutdown if `error` event is emitted.
      this.socket.on('error', err => {

        // Close terminal session.
        this._close();

        // EIO, happens when someone closes our child
        // process: the only process in the terminal.
        // node < 0.6.14: errno 5
        // node >= 0.6.14: read EIO
        if (err.code) {
          if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return;
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
      this.agent.ptyInSocket.write(data);
    });
  }

  /**
   * TTY
   */

  public resize(cols: number, rows: number): void {
    this._defer(() => {
      // TODO: Call this within WindowsPtyAgent
      pty.resize(this.pid, cols, rows);
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
      // TODO: Call this within WindowsPtyAgent
      pty.kill(this.pid);
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
