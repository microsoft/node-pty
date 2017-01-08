/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import { ITerminal } from './interfaces';

export abstract class Terminal implements ITerminal {
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

  /** See net.Socket.end */
  public end(data: string) {
    return this.socket.end(data);
  }

  /** See stream.Readable.pipe */
  public pipe(dest: any, options: any) {
    return this.socket.pipe(dest, options);
  }

  /** See net.Socket.pause */
  public pause(): void {
    return this.socket.pause();
  }

  /** See net.Socket.resume */
  public resume(): void {
    return this.socket.resume();
  }

  /** See net.Socket.setEncoding */
  public setEncoding(encoding: string): void {
    if (this.socket._decoder) {
      delete this.socket._decoder;
    }
    if (encoding) {
      this.socket.setEncoding(encoding);
    }
  }

  public addListener(type: string, listener: (...args: any[]) => any): void { this.on(type, listener); }
  public on(type: string, listener: (...args: any[]) => any): void {
    if (type === 'close') {
      this._internalee.on('close', listener);
      return;
    }
    this.socket.on(type, listener);
  }

  public emit(event: string, ...args: any[]): any {
    if (event === 'close') {
      return this._internalee.emit.apply(this._internalee, arguments);
    }
    return this.socket.emit.apply(this.socket, arguments);
  }

  public listeners(type: string) {
    return this.socket.listeners(type);
  }

  public removeListener(type: string, listener: (...args: any[]) => any): void {
    this.socket.removeListener(type, listener);
  }

  public removeAllListeners(type: string): void {
    this.socket.removeAllListeners(type);
  }

  public once(type: string, listener: (...args: any[])): void {
    this.socket.once(type, listener);
  }

  public get stdin() { return this; }
  public get stdout() { return this; }
  public get stderr() { throw new Error('No stderr.'); }

  public abstract write(data: string): void;
  public abstract resize(cols: number, rows: number): void;
  public abstract destroy(): void;
  public abstract kill(signal?: string): void;

  /**
   * Gets the name of the process.
   */
  public abstract get process(): string;

  // TODO: Should this be in the API?
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
