/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as os from 'os';
import { Terminal as BaseTerminal } from './terminal';
import { ITerminal, IPtyOpenOptions, IPtyForkOptions } from './interfaces';

let Terminal: any;
if (os.platform() === 'win32') {
  Terminal = require('./windowsTerminal').WindowsTerminal;
} else {
  Terminal = require('./unixTerminal').UnixTerminal;
}

export function spawn(file?: string, args?: string[], opt?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, opt);
};

/** @deprecated */
export function fork(file?: string, args?: string[], opt?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, opt);
};

/** @deprecated */
export function createTerminal(file?: string, args?: string[], opt?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, opt);
};

export function open(opt: IPtyOpenOptions): ITerminal {
  return Terminal.open(opt);
}
