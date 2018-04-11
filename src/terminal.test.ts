/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 */

import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import { UnixTerminal } from './unixTerminal';
import { Terminal } from './terminal';
import pollUntil = require('pollUntil');

let PlatformTerminal: WindowsTerminal | UnixTerminal;
if (process.platform === 'win32') {
  PlatformTerminal = require('./windowsTerminal');
} else {
  PlatformTerminal = require('./unixTerminal');
}

function newTerminal(): Terminal {
  return process.platform === 'win32' ? new WindowsTerminal() : new UnixTerminal();
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

  describe('terminal write()',  () => {

    it('should emit "data"', (done) => {
      const terminal: Terminal = newTerminal();
      let allTheData = '';
      terminal.on('data', (chunk) => {
        allTheData += chunk;
      });
      (<any>pollUntil)(() => {
        if (allTheData.indexOf('hello') !== -1 && allTheData.indexOf('world') !== -1) {
          terminal.destroy();
          done();
          return true;
        }
        return false;
      });
      terminal.write('hello');
      terminal.write('world');
    });

    describe('write() callback, input consumption and "drain" event', () => {
    //   // let shortTime;
    //   // let longTime;

    //   it('should notify if the was completely consumed', (done) => {
    //     const shortString = 'echo 1\f';
    //     terminal = newTerminal();
    //     let flushedAlready = false;
    //     // shortTime = Date.now();
    //     terminal.write(shortString, (flushed: boolean) => {
    //       if (!flushedAlready && flushed) {
    //         flushedAlready = true;
    //         // shortTime = Date.now() - shortTime;
    //         terminal.destroy();
    //         done && done();
    //         done = null;
    //       }
    //     });
    //   });

      let terminalWriteDescribe;
      function buildLongInput(): string {
        const count = process.platform === 'win32' ? 8 : 4;
        let s = terminalWriteDescribe.toString() + '\f';
        for (let i = 0; i < count; i++) {
          s += s;
        }
        return s;
      }
      let shouldEmitDrain = false;
      let drainEmitted = false;
      let terminal;

      it('should provide meanings to know if the entire data was flushed successfully to the kernel buffer or was queued in user memory', terminalWriteDescribe = (done) => {
        let longString = buildLongInput();
        terminal = newTerminal();
        terminal.on('drain', () => {
          drainEmitted = true;
        });
        let flushedAlready = false;
        // longTime = Date.now();
        terminal.write(longString, (flushed: boolean) => {
          if (!flushedAlready && flushed) {
            flushedAlready = true;
            // longTime = Date.now() - longTime;
            // assert.ok(longTime > shortTime, 'inputs considerably bigger should take more time to flush');
            // terminal.destroy();// dont destroy the terminal not yet because it could still emit some events we are interested on
            done && done();
            done = null;
          }
          else {
            shouldEmitDrain = true;
          }
        });
      }).timeout(4000);

      it('should emit "drain" event to know when the kernel buffer is free again', () => {
        if (process.platform === 'win32') {
          assert.ok(true, 'winpty doesn\'t support "drain" event');
        }
        else if (shouldEmitDrain) {
          assert.ok(drainEmitted, '"drain" event should be emitted when input to write cannot be flushed entirely');
        }
        else {
          assert.ok(!drainEmitted, '"drain" event shouldn\'t be emitted if write input was flushed entirely');
        }
      });

      it('clean up', () => {
        terminal.destroy();
      });

    });
  });
});
