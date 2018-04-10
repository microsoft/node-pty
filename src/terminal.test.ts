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

let terminalWriteDescribe;
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

  describe('terminal write()', terminalWriteDescribe = () => {

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

    describe('write callback', () => {
      let shortTime;
      let longTime;
      let shouldEmitDrain = false;
      let drainEmitted = false;

      it('should flush quickly short strings', (done) => {
        const shortString = 'ls\f';
        const terminal = newTerminal();
        let flushedAlready = false;
        shortTime = Date.now();
        terminal.write(shortString, (flushed: boolean) => {
          if (!flushedAlready && flushed) {
            flushedAlready = true;
            shortTime = Date.now() - shortTime;
            terminal.destroy();
            done && done();
            done = null;
          }
        });
      });

      it('long strings should take longer', (done) => {
        let longString = terminalWriteDescribe.toString() + '\f';
        for (let i = 0; i < 3; i++) {
          longString += longString;
        }
        const terminal = newTerminal();
        terminal.on('drain', () => {
          drainEmitted = true;
        });
        let flushedAlready = false;
        longTime = Date.now();
        terminal.write(longString, (flushed: boolean) => {
          if (!flushedAlready && flushed) {
            flushedAlready = true;
            longTime = Date.now() - longTime;
            console.log({longTime, shortTime});
            terminal.destroy();
            assert.ok(longTime > shortTime, 'inputs considerably bigger should take more time to flush');
            done && done();
            done = null;
          }
          else {
            shouldEmitDrain = true;
          }
        });
      }).timeout(4000);

      it('should emit ""drain" event when data could not be flushed entirely', () => {
        if (shouldEmitDrain) {
          assert.ok(drainEmitted, '"drain" event should be emitted when input to write cannot be flushed entirely');
        }
        else {
          assert.ok(!drainEmitted, '"drain" event shouldn\'t be emitted if write input was flushed entirely');
        }
      });

    });
  });
});
