/**
 * Copyright (c) 2018, Microsoft (MIT License).
 */

interface IConptyNative {
  startProcess(file: string, cols: number, rows: number, debug: boolean, pipeName: string): IConptyPty;
}

interface IWinptyNative {
  startProcess(file, commandLine, env, cwd, cols, rows, debug): IConptyPty;
}

interface IConptyPty {
  pty: number;
  fd: number;
  conin: string;
  conout: string;
}
