/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 */

import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import { UnixTerminal } from './unixTerminal';
import { spawn } from '.';

let PlatformTerminal: WindowsTerminal | UnixTerminal;
if (process.platform === 'win32') {
  PlatformTerminal = require('./windowsTerminal');
} else {
  PlatformTerminal = require('./unixTerminal');
}

describe('Terminal', () => {
  describe('constructor', () => {
    it('should do basic type checks', () => {
      assert.throws(
        () => new (<any>PlatformTerminal)('a', 'b', { 'name': {} }),
        'name must be a string (not a object)'
      );
    });
  });

  describe('getSocket', () => {
    it('should return a Socket instance', () => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const client = spawn(shell, [], {});
      assert.equal( client.getSocket().destroyed, false, 'socket shouldn\'t be destroyed yet' );
      client.destroy();
      assert.equal( client.getSocket().destroyed, true, 'socket should be destroyed' );
    });
  });

});
