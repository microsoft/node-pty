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

  constructor(file, args, opt) {
    super();

    const self = this;
    let env, cwd, name, cols, rows, term, agent, debug;

    // Backward compatibility.
    if (typeof args === 'string') {
      opt = {
        name: arguments[1],
        cols: arguments[2],
        rows: arguments[3],
        cwd: process.env.HOME
      };
      args = [];
    }

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
    debug = opt.debug || false;

    env.TERM = name;

    // Initialize environment variables.
    env = this._parseEnv(env);

    // If the terminal is ready
    this.isReady = false;

    // Functions that need to run after `ready` event is emitted.
    this.deferreds = [];

    // Create new termal.
    this.agent = new WindowsPtyAgent(file, args, env, cwd, cols, rows, debug);

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
    this.socket.on('ready_datapipe', function () {

      // These events needs to be forwarded.
      ['connect', 'data', 'end', 'timeout', 'drain'].forEach(function(event) {
        self.socket.on(event, function(data) {

          // Wait until the first data event is fired
          // then we can run deferreds.
          if (!self.isReady && event === 'data') {

            // Terminal is now ready and we can
            // avoid having to defer method calls.
            self.isReady = true;

            // Execute all deferred methods
            self.deferreds.forEach(function(fn) {
              // NB! In order to ensure that `this` has all
              // its references updated any variable that
              // need to be available in `this` before
              // the deferred is run has to be declared
              // above this forEach statement.
              fn.run();
            });

            // Reset
            self.deferreds = [];

          }
        });
      });

      // Resume socket.
      self.socket.resume();

      // Shutdown if `error` event is emitted.
      self.socket.on('error', function (err) {

        // Close terminal session.
        self._close();

        // EIO, happens when someone closes our child
        // process: the only process in the terminal.
        // node < 0.6.14: errno 5
        // node >= 0.6.14: read EIO
        if (err.code) {
          if (~err.code.indexOf('errno 5') || ~err.code.indexOf('EIO')) return;
        }

        // Throw anything else.
        if (self.listeners('error').length < 2) {
          throw err;
        }

      });

      // Cleanup after the socket is closed.
      self.socket.on('close', function () {
        self.emit('exit', null);
        self._close();
      });

    });

    this.file = file;
    this.name = name;
    this.cols = cols;
    this.rows = rows;

    this.readable = true;
    this.writable = true;
  }

  /**
   * openpty
   */

  public open(opt) {
    throw new Error('open() not supported on windows, use Fork() instead.');
  }

  /**
   * Events
   */

  public write(data) {
    this._defer(this, function() {
      this.agent.ptyInSocket.write(data);
    });
  }

  /**
   * TTY
   */

  public resize(cols, rows) {
    this._defer(this, function() {

      cols = cols || Terminal.DEFAULT_COLS;
      rows = rows || Terminal.DEFAULT_ROWS;

      this.cols = cols;
      this.rows = rows;

      // TODO: Call this within WindowsPtyAgent
      pty.resize(this.pid, cols, rows);
    });
  }

  public destroy() {
    this._defer(this, function() {
      this.kill();
    });
  }

  public kill(sig) {
    this._defer(this, function() {
      if (sig !== undefined) {
        throw new Error('Signals not supported on windows.');
      }
      this._close();
      // TODO: Call this within WindowsPtyAgent
      pty.kill(this.pid);
    });
  }

  private _defer(terminal, deferredFn) {

    // Ensure that this method is only used within Terminal class.
    if (!(terminal instanceof WindowsTerminal)) {
      throw new Error('Must be instanceof WindowsTerminal');
    }

    // If the terminal is ready, execute.
    if (terminal.isReady) {
      deferredFn.apply(terminal, null);
      return;
    }

    // Queue until terminal is ready.
    terminal.deferreds.push({
      run: function() {
        // Run deffered.
        deferredFn.apply(terminal, null);
      }
    });
  }

  public get process() { return this.name; }
}
