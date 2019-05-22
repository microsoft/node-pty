/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 */

import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import { UnixTerminal } from './unixTerminal';
import { IPtyForkOptions } from './interfaces';
import { ArgvOrCommandLine } from './types';

interface ITerminalCtor {
  new(file?: string, args?: ArgvOrCommandLine, opt?: IPtyForkOptions): WindowsTerminal | UnixTerminal;
}

const terminalConstructor = (process.platform === 'win32') ? WindowsTerminal : UnixTerminal;

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

  // FIXME: adopt for windows
  describe('automatic flow control', () => {
    it('should respect ctor flow control options', () => {
      const pty = new terminalConstructor('/bin/bash', [], {handleFlowControl: true, flowPause: 'abc', flowResume: '123'});
      // write got replaced
      assert.equal((pty as any)._realWrite !== null, true);
      // correct values of flowPause and flowResume
      assert.equal((pty as any)._flowPause, 'abc');
      assert.equal((pty as any)._flowResume, '123');
    });
    it('should do flow control automatically', (done) => {
      const pty = new terminalConstructor('/bin/bash', [], {handleFlowControl: true, flowPause: 'PAUSE', flowResume: 'RESUME'});
      const read: string[] = [];
      pty.on('data', data => read.push(data));
      pty.on('pause', () => read.push('paused'));
      pty.on('resume', () => read.push('resumed'));
      setTimeout(() => pty.write('1'), 100);
      setTimeout(() => pty.write('PAUSE'), 200);
      setTimeout(() => pty.write('2'), 300);
      setTimeout(() => pty.write('RESUME'), 400);
      setTimeout(() => pty.write('3'), 500);
      setTimeout(() => {
        // read should contain ['resumed', '<PROMPT>', '1', 'paused', 'resumed', '2', '3']
        // import here: no data should be delivered between 'paused' and 'resumed'
        assert.deepEqual(read.slice(2), ['1', 'paused', 'resumed', '2', '3']);
        done();
      }, 1000);
    });
    it('should enable/disable automatic flow control', () => {
      const pty = new terminalConstructor('/bin/bash', []);
      // write got not yet replaced
      assert.equal((pty as any)._realWrite, null);
      pty.enableFlowHandling();
      assert.equal((pty as any)._realWrite !== null, true);
      pty.disableFlowHandling();
      assert.equal((pty as any)._realWrite, null);
    });
  });
});
