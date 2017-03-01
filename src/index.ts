/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as os from 'os';
import { Terminal as BaseTerminal } from './terminal';
import { ITerminal, IPtyOpenOptions, IPtyForkOptions } from './interfaces';
import { ArgsOrArgv } from './types';

let Terminal: any;
if (os.platform() === 'win32') {
  Terminal = require('./windowsTerminal').WindowsTerminal;
} else {
  Terminal = require('./unixTerminal').UnixTerminal;
}

/**
 * Forks a process as a pseudoterminal.
 * @param file The file to launch.
 * @param args The command line arguments as a string array or a string. Note
 * that the string option is only available on Windows and all escaping of the
 * arguments must be done manually.
 * @param options The options of the terminal.
 */
export function fork(file?: string, args?: ArgsOrArgv, options?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, options);
};

export function spawn(file?: string, args?: ArgsOrArgv, options?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, options);
};

export function createTerminal(file?: string, args?: ArgsOrArgv, options?: IPtyForkOptions): ITerminal {
  return new Terminal(file, args, options);
};

export function open(options: IPtyOpenOptions): ITerminal {
  return Terminal.open(options);
}
