/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';
import { ArgvOrCommandLine } from './types';

const pty = require(path.join('..', 'build', 'Release', 'pty.node'));

/**
 * Agent. Internal class.
 *
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 */

export class WindowsPtyAgent {
  private _inSocket: net.Socket;
  private _outSocket: net.Socket;
  private _pid: number;
  private _innerPid: number;
  private _innerPidHandle: number;

  private _fd: any;
  private _pty: number;

  public get inSocket(): net.Socket { return this._inSocket; }
  public get outSocket(): net.Socket { return this._outSocket; }
  public get fd(): any { return this._fd; }
  public get innerPid(): number { return this._innerPid; }
  public get pty(): number { return this._pty; }

  constructor(
    file: string,
    args: ArgvOrCommandLine,
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    debug: boolean
  ) {
    // Sanitize input variable.
    cwd = path.resolve(cwd);

    // Compose command line
    const commandLine = argsToCommandLine(file, args);

    // Open pty session.
    const term = pty.startProcess(file, commandLine, env, cwd, cols, rows, debug);

    // Terminal pid.
    this._pid = term.pid;
    this._innerPid = term.innerPid;
    this._innerPidHandle = term.innerPidHandle;

    // Not available on windows.
    this._fd = term.fd;

    // Generated incremental number that has no real purpose besides  using it
    // as a terminal id.
    this._pty = term.pty;

    // Create terminal pipe IPC channel and forward to a local unix socket.
    this._outSocket = new net.Socket();
    this._outSocket.setEncoding('utf8');
    this._outSocket.connect(term.conout, () => {
      // TODO: Emit event on agent instead of socket?

      // Emit ready event.
      this._outSocket.emit('ready_datapipe');
    });

    this._inSocket = new net.Socket();
    this._inSocket.setEncoding('utf8');
    this._inSocket.connect(term.conin);
    // TODO: Wait for ready event?
  }

  public resize(cols: number, rows: number): void {
    pty.resize(this._pid, cols, rows);
  }

  public kill(): void {
    this._inSocket.readable = false;
    this._inSocket.writable = false;
    this._outSocket.readable = false;
    this._outSocket.writable = false;
    pty.kill(this._pid, this._innerPidHandle);
  }
}

// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN (e.g. see CommandLineToArgvW documentation). Copied from
// winpty project.
export function argsToCommandLine(file: string, args: ArgvOrCommandLine): string {
  if (isCommandLine(args)) {
    if (args.length === 0) {
      return file;
    }
    return `${argsToCommandLine(file, [])} ${args}`;
  }
  const argv = [file];
  Array.prototype.push.apply(argv, args);
  let result = '';
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) {
      result += ' ';
    }
    const arg = argv[argIndex];
    const quote =
      arg.indexOf(' ') !== -1 ||
      arg.indexOf('\t') !== -1 ||
      arg === '';
    if (quote) {
      result += '\"';
    }
    let bsCount = 0;
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i];
      if (p === '\\') {
        bsCount++;
      } else if (p === '"') {
        result += repeatText('\\', bsCount * 2 + 1);
        result += '"';
        bsCount = 0;
      } else {
        result += repeatText('\\', bsCount);
        bsCount = 0;
        result += p;
      }
    }
    if (quote) {
      result += repeatText('\\', bsCount * 2);
      result += '\"';
    } else {
      result += repeatText('\\', bsCount);
    }
  }
  return result;
}

function isCommandLine(args: ArgvOrCommandLine): args is string {
  return typeof args === 'string';
}

function repeatText(text: string, count: number): string {
  let result = '';
  for (let i = 0; i < count; i++) {
    result += text;
  }
  return result;
}
