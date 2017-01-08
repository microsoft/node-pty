/**
 * pty_win.js
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

import { WindowsTerminal } from './windowsTerminal';

export function fork(file, args, opt) { 
  return new WindowsTerminal(file, args, opt);
};

export function spawn(file, args, opt) {
  return new WindowsTerminal(file, args, opt);
};

export function createTerminal(file, args, opt) {
  return new WindowsTerminal(file, args, opt);
};
