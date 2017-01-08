/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import * as os from 'os';

let Terminal;
if (os.platform() === 'win32') {
  Terminal = require('./windowsTerminal').WindowsTerminal;
} else {
  Terminal = require('./unixTerminal').UnixTerminal;
}

export function fork(file, args, opt) {
  return new Terminal(file, args, opt);
};

export function spawn(file, args, opt) {
  return new Terminal(file, args, opt);
};

export function createTerminal(file, args, opt) {
  return new Terminal(file, args, opt);
};
