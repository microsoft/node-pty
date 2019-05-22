/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import { UnixTerminal } from './unixTerminal';

const terminalConstructor = (process.platform === 'win32') ? WindowsTerminal : UnixTerminal;
const SHELL = (process.platform === 'win32') ? 'cmd.exe' : '/bin/bash';

let terminalCtor: WindowsTerminal | UnixTerminal;
if (process.platform === 'win32') {
  terminalCtor = require('./windowsTerminal');
} else {
  terminalCtor = require('./unixTerminal');
}


describe('Terminal', () => {
  describe('constructor', () => {
    it('should do basic type checks', () => {
      assert.throws(
        () => new (<any>terminalCtor)('a', 'b', { 'name': {} }),
        'name must be a string (not a object)'
      );
    });
  });

  describe('automatic flow control', () => {
    it('should respect ctor flow control options', () => {
      const pty = new terminalConstructor(SHELL, [], {handleFlowControl: true, flowPause: 'abc', flowResume: '123'});
      assert.equal((pty as any)._handleFlowControl, true);
      assert.equal((pty as any)._flowPause, 'abc');
      assert.equal((pty as any)._flowResume, '123');
    });
    it('should do flow control automatically', function(done) {
      this.timeout(3000);
      const pty = new terminalConstructor(SHELL, [], {handleFlowControl: true, flowPause: 'PAUSE', flowResume: 'RESUME'});
      const read: string[] = [];
      pty.on('data', data => read.push(data));
      pty.on('pause', () => read.push('paused'));
      pty.on('resume', () => read.push('resumed'));
      setTimeout(() => pty.write('1'), 1000);
      setTimeout(() => pty.write('PAUSE'), 1200);
      setTimeout(() => pty.write('2'), 1400);
      setTimeout(() => pty.write('RESUME'), 1600);
      setTimeout(() => pty.write('3'), 1800);
      setTimeout(() => {
        // important here: no data should be delivered between 'paused' and 'resumed'
        if (process.platform === 'win32') {
          // cmd.exe always clears to the end of line?
          assert.deepEqual(read.slice(-5), ['1\u001b[0K', 'paused', 'resumed', '2\u001b[0K', '3\u001b[0K']);
        } else {
          assert.deepEqual(read.slice(-5), ['1', 'paused', 'resumed', '2', '3']);
        }
        done();
      }, 2000);
    });
    it('should enable/disable automatic flow control', () => {
      const pty = new terminalConstructor(SHELL, []);
      // write got not yet replaced
      assert.equal((pty as any)._realWrite, null);
      pty.enableFlowControl();
      assert.equal((pty as any)._realWrite !== null, true);
      pty.disableFlowControl();
      assert.equal((pty as any)._realWrite, null);
    });
  });
});
