/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as os from 'os';
import * as path from 'path';
import { Socket } from 'net';
import { ArgvOrCommandLine } from './types';

let pty: any;

/**
 * Agent. Internal class.
 *
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 */

export class WindowsPtyAgent {
  private _inSocket: Socket;
  private _outSocket: Socket;
  private _pid: number;
  private _innerPid: number;
  private _innerPidHandle: number;

  private _fd: any;
  private _pty: number;

  public get inSocket(): Socket { return this._inSocket; }
  public get outSocket(): Socket { return this._outSocket; }
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
    debug: boolean,
    private _useConpty: boolean | undefined
  ) {
    if (!pty) {
      if (this._useConpty === undefined) {
        this._useConpty = this._getWindowsBuildNumber() >= 17692;
      }
      console.log('useConpty?', this._useConpty);
      pty = require(path.join('..', 'build', /*'Debug'*/'Release', `${this._useConpty ? 'conpty' : 'pty'}.node`));
    }

    // Sanitize input variable.
    cwd = path.resolve(cwd);

    // Compose command line
    const commandLine = argsToCommandLine(file, args);

    // Open pty session.
    let term;
    if (this._useConpty) {
      term = pty.startProcess(file, cols, rows, debug, this._generatePipeName());
    } else {
      term = pty.startProcess(file, commandLine, env, cwd, cols, rows, debug);
      this._pid = term.pid;
    }

    // Terminal pid.
    this._innerPid = term.innerPid;
    this._innerPidHandle = term.innerPidHandle;

    // Not available on windows.
    this._fd = term.fd;

    // Generated incremental number that has no real purpose besides  using it
    // as a terminal id.
    this._pty = term.pty;

    // Create terminal pipe IPC channel and forward to a local unix socket.
    this._outSocket = new Socket();
    this._outSocket.setEncoding('utf8');
    this._outSocket.connect(term.conout, () => {
      // TODO: Emit event on agent instead of socket?

      // Emit ready event.
      this._outSocket.emit('ready_datapipe');
    });

    this._inSocket = new Socket();
    this._inSocket.setEncoding('utf8');
    this._inSocket.connect(term.conin);
    // TODO: Wait for ready event?

    // TODO: Do we *need* to timeout here or wait for the sockets to connect?
    //    or can we do this synchronously like this?
    if (this._useConpty) {
      console.log('this._pty = ' + this._pty);
      const connect = pty.connect(this._pty, commandLine, cwd, env);
      console.log('connect.error' + connect.error);
      this._innerPid = connect.pid;
    }
  }

  public resize(cols: number, rows: number): void {
    // TODO: Guard against invalid pty values
    pty.resize(this._useConpty ? this._pty : this._pid, cols, rows);
  }

  public kill(): void {
    this._inSocket.readable = false;
    this._inSocket.writable = false;
    this._outSocket.readable = false;
    this._outSocket.writable = false;
    // Tell the agent to kill the pty, this releases handles to the process
    if (this._useConpty) {
      pty.kill(this._pty);
    } else {
      const processList: number[] = pty.getProcessList(this._pid);
      pty.kill(this._pid, this._innerPidHandle);
      // Since pty.kill will kill most processes by itself and process IDs can be
      // reused as soon as all handles to them are dropped, we want to immediately
      // kill the entire console process list. If we do not force kill all
      // processes here, node servers in particular seem to become detached and
      // remain running (see Microsoft/vscode#26807).
      processList.forEach(pid => {
        try {
          process.kill(pid);
        } catch (e) {
          // Ignore if process cannot be found (kill ESRCH error)
        }
      });
    }
  }

  public getExitCode(): number {
    return pty.getExitCode(this._innerPidHandle);
  }

  private _getWindowsBuildNumber(): number {
    const osVersion = (/(\d+)\.(\d+)\.(\d+)/g).exec(os.release());
    let buildNumber: number = 0;
    if (osVersion && osVersion.length === 4) {
      buildNumber = parseInt(osVersion[3]);
    }
    return buildNumber;
  }

  private _generatePipeName(): string {
    return `conpty-${Math.random() * 10000000}`;
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
