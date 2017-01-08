/**
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

export interface IPty {
  createTerminal(file?: string, args?: string[], opt?: IPtyForkOptions);
  fork(file?: string, args?: string[], opt?: IPtyForkOptions);
  spawn(file?: string, args?: string[], opt?: IPtyForkOptions);
  open(opt?: IPtyOpenOptions);
}

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: {[key: string]: string};
}

export interface IPtyOpenOptions {
  cols?: number;
  rows?: number;
}
