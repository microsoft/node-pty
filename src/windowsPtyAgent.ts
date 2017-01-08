/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as net from 'net';
import * as path from 'path';

let pty;
try {
  pty = require(path.join('..', 'build', 'Release', 'pty.node'));
} catch (e) {
  pty = require(path.join('..', 'build', 'Debug', 'pty.node'));
};

/**
 * Agent. Internal class.
 *
 * Everytime a new pseudo terminal is created it is contained
 * within agent.exe. When this process is started there are two
 * available named pipes (control and data socket).
 */

export function WindowsPtyAgent(file: string, args: string[], env: string[], cwd: string, cols: number, rows: number, debug: boolean): void {
  // Unique identifier per pipe created.
  const timestamp = Date.now();

  // Sanitize input variable.
  file = file;
  cwd = path.resolve(cwd);

  // Compose command line
  const cmdline = [file];
  Array.prototype.push.apply(cmdline, args);
  const cmdlineFlat = argvToCommandLine(cmdline);

  // Open pty session.
  const term = pty.startProcess(file, cmdlineFlat, env, cwd, cols, rows, debug);
  this.dataPipeIn = term.conin;
  this.dataPipeOut = term.conout;

  // Terminal pid.
  this.pid = term.pid;

  // Not available on windows.
  this.fd = term.fd;

  // Generated incremental number that has no real purpose besides
  // using it as a terminal id.
  this.pty = term.pty;

  // Create terminal pipe IPC channel and forward to a local unix socket.
  this.ptyOutSocket = new net.Socket();
  this.ptyOutSocket.setEncoding('utf8');
  this.ptyOutSocket.connect(this.dataPipeOut, () => {
    // TODO: Emit event on agent instead of socket?

    // Emit ready event.
    this.ptyOutSocket.emit('ready_datapipe');
  });

  this.ptyInSocket = new net.Socket();
  this.ptyInSocket.setEncoding('utf8');
  this.ptyInSocket.connect(this.dataPipeIn);
  // TODO: Wait for ready event?
}

// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN.  (e.g. see CommandLineToArgvW documentation)
// Copied from winpty project.
function argvToCommandLine(argv: string[]): string {
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

function repeatText(text: string, count: number): string {
  let result = text;
  for (let i = 1; i < count; i++) {
    result += text;
  }
  return result;
}
