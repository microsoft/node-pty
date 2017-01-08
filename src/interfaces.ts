/**
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

export interface ITerminal {
  process: string;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  destroy(): void;
  kill(signal?: string): void;
  setEncoding(encoding: string): void;
  resume(): void;
  pause(): void;
}

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: {[key: string]: string};
  uid?: number;
  gid?: number;
}

export interface IPtyOpenOptions {
  cols?: number;
  rows?: number;
}
