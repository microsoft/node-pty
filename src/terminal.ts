/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as path from 'path';
import { EventEmitter } from 'events';

export abstract class Terminal {
  protected static readonly DEFAULT_COLS = 80;
  protected static readonly DEFAULT_ROWS = 24;

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

  protected _internalee: any;

  constructor() {
    // for 'close'
    this._internalee = new EventEmitter();
  }

  public end(data) {
    return this.socket.end(data);
  }

  public pipe(dest, options) {
    return this.socket.pipe(dest, options);
  }

  public pause() {
    return this.socket.pause();
  }

  public resume() {
    return this.socket.resume();
  }

  public setEncoding(enc) {
    if (this.socket._decoder) {
      delete this.socket._decoder;
    }
    if (enc) {
      this.socket.setEncoding(enc);
    }
  }

  public addListener(type, func) { return this.on(type, func); }
  public on(type, func) {
    if (type === 'close') {
      this._internalee.on('close', func);
      return this;
    }
    this.socket.on(type, func);
    return this;
  }

  public emit(evt, ...args) {
    if (evt === 'close') {
      return this._internalee.emit.apply(this._internalee, arguments);
    }
    return this.socket.emit.apply(this.socket, arguments);
  }

  public listeners(type) {
    return this.socket.listeners(type);
  }

  public removeListener(type, func) {
    this.socket.removeListener(type, func);
    return this;
  }

  public removeAllListeners(type) {
    this.socket.removeAllListeners(type);
    return this;
  }

  public once(type, func) {
    this.socket.once(type, func);
    return this;
  }

  public get stdin() { return this; }
  public get stdout() { return this; }
  public get stderr() { throw new Error('No stderr.'); }

  public abstract write(data);
  public abstract resize(cols, rows);
  public abstract open(opt);
  public abstract destroy();
  public abstract kill(sig);
  public abstract get process();

  public redraw() {
    let self = this;
    let cols = this.cols;
    let rows = this.rows;

    // We could just send SIGWINCH, but most programs will
    // ignore it if the size hasn't actually changed.

    this.resize(cols + 1, rows + 1);

    setTimeout(function() {
      self.resize(cols, rows);
    }, 30);
  }

  protected _close() {
    this.socket.writable = false;
    this.socket.readable = false;
    this.write = function() {};
    this.end = function() {};
    this.writable = false;
    this.readable = false;
  }

  protected _parseEnv(env: {[key: string]: string}) {
    const keys = Object.keys(env || {});
    const pairs = [];

    for (let i = 0; i < keys.length; i++) {
      pairs.push(keys[i] + '=' + env[keys[i]]);
    }

    return pairs;
  }
}
