/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as path from 'path';
import { Socket } from 'net';
import { EventEmitter } from 'events';
import { ITerminal, IPtyForkOptions } from './interfaces';

export abstract class Terminal implements ITerminal {
  protected static readonly DEFAULT_COLS: number = 80;
  protected static readonly DEFAULT_ROWS: number = 24;

  protected socket: Socket;
  protected pid: number;
  protected fd: number;
  protected pty: any;

  protected file: string;
  protected name: string;
  protected cols: number;
  protected rows: number;

  protected readable: boolean;
  protected writable: boolean;

  protected _internalee: EventEmitter;

  constructor(opt?: IPtyForkOptions) {
    // for 'close'
    this._internalee = new EventEmitter();

    if (!opt) {
      return;
    }

    // Do basic type checks here in case node-pty is being used within JavaScript. If the wrong
    // types go through to the C++ side it can lead to hard to diagnose exceptions.
    this._checkType('name', opt.name ? opt.name : null, 'string');
    this._checkType('cols', opt.cols ? opt.cols : null, 'number');
    this._checkType('rows', opt.rows ? opt.rows : null, 'number');
    this._checkType('cwd', opt.cwd ? opt.cwd : null, 'string');
    this._checkType('env', opt.env ? opt.env : null, 'object');
    this._checkType('uid', opt.uid ? opt.uid : null, 'number');
    this._checkType('gid', opt.gid ? opt.gid : null, 'number');
    this._checkType('encoding', opt.encoding ? opt.encoding : null, 'string');
  }

  private _checkType(name: string, value: any, type: string): void {
    if (value && typeof value !== type) {
      throw new Error(`${name} must be a ${type} (not a ${typeof value})`);
    }
  }

  /** See net.Socket.end */
  public end(data: string): void{
    this.socket.end(data);
  }

  /** See stream.Readable.pipe */
  public pipe(dest: any, options: any): any {
    return this.socket.pipe(dest, options);
  }

  /** See net.Socket.pause */
  public pause(): Socket {
    return this.socket.pause();
  }

  /** See net.Socket.resume */
  public resume(): Socket {
    // TODO: Type with Socket
    return this.socket.resume();
  }

  /** See net.Socket.setEncoding */
  public setEncoding(encoding: string): void {
    if ((<any>this.socket)._decoder) {
      delete (<any>this.socket)._decoder;
    }
    if (encoding) {
      this.socket.setEncoding(encoding);
    }
  }

  public addListener(eventName: string, listener: (...args: any[]) => any): void { this.on(eventName, listener); }
  public on(eventName: string, listener: (...args: any[]) => any): void {
    if (eventName === 'close') {
      this._internalee.on('close', listener);
      return;
    }
    this.socket.on(eventName, listener);
  }

  public emit(eventName: string, ...args: any[]): any {
    if (eventName === 'close') {
      return this._internalee.emit.apply(this._internalee, arguments);
    }
    return this.socket.emit.apply(this.socket, arguments);
  }

  public listeners(eventName: string): Function[] {
    return this.socket.listeners(eventName);
  }

  public removeListener(eventName: string, listener: (...args: any[]) => any): void {
    this.socket.removeListener(eventName, listener);
  }

  public removeAllListeners(eventName: string): void {
    this.socket.removeAllListeners(eventName);
  }

  public once(eventName: string, listener: (...args: any[]) => any): void {
    this.socket.once(eventName, listener);
  }

  public abstract write(data: string): void;
  public abstract resize(cols: number, rows: number): void;
  public abstract destroy(): void;
  public abstract kill(signal?: string): void;

  /**
   * Gets the name of the process.
   */
  public abstract get process(): string;

  // TODO: Should this be in the API?
  public redraw(): void {
    let cols = this.cols;
    let rows = this.rows;

    // We could just send SIGWINCH, but most programs will  ignore it if the
    // size hasn't actually changed.

    this.resize(cols + 1, rows + 1);

    setTimeout(() => this.resize(cols, rows), 30);
  }

  protected _close(): void {
    this.socket.writable = false;
    this.socket.readable = false;
    this.write = () => {};
    this.end = () => {};
    this.writable = false;
    this.readable = false;
  }

  protected _parseEnv(env: {[key: string]: string}): string[] {
    const keys = Object.keys(env || {});
    const pairs = [];

    for (let i = 0; i < keys.length; i++) {
      pairs.push(keys[i] + '=' + env[keys[i]]);
    }

    return pairs;
  }
}
