/**
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

interface IPty {
  createTerminal(file: string, args: string[], opt: IPtyOptions);
  fork(file: string, args: string[], opt: IPtyOptions);
  spawn(file: string, args: string[], opt: IPtyOptions);
}

interface IPtyOptions {
  name?: string;
  cols?: number;
  rows?: 30;
  cwd?: string;
  env?: {[key: string]: string};
}
