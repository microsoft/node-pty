/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 */

import { UnixTerminal } from './unixTerminal';
import * as assert from 'assert';
import pollUntil = require('pollUntil');
import * as path from 'path';

const FIXTURES_PATH = path.normalize(path.join(__dirname, '..', 'fixtures', 'utf8-character.txt'));

if (process.platform !== 'win32') {
  describe('UnixTerminal', () => {
    describe('Constructor', () => {
      it('should set a valid pts name', () => {
        const term = new UnixTerminal('/bin/bash', [], {});
        let regExp;
        if (process.platform === 'linux') {
          // https://linux.die.net/man/4/pts
          regExp = /^\/dev\/pts\/\d+$/;
        }
        if (process.platform === 'darwin') {
          // https://developer.apple.com/legacy/library/documentation/Darwin/Reference/ManPages/man4/pty.4.html
          regExp = /^\/dev\/tty[p-sP-S][a-z0-9]+$/;
        }
        if (regExp) {
          assert.ok(regExp.test((<any>term)._pty), '"' + (<any>term)._pty + '" should match ' + regExp.toString());
        }
      });
    });

    describe('PtyForkEncodingOption', () => {
      it('should default to utf8', (done) => {
        const term = new UnixTerminal('/bin/bash', [ '-c', `cat "${FIXTURES_PATH}"` ]);
        term.on('data', (data) => {
          assert.equal(typeof data, 'string');
          assert.equal(data, '\u00E6');
          done();
        });
      });
      it('should return a Buffer when encoding is null', (done) => {
        const term = new UnixTerminal('/bin/bash', [ '-c', `cat "${FIXTURES_PATH}"` ], {
          encoding: null
        });
        term.on('data', (data) => {
          assert.equal(typeof data, 'object');
          assert.ok(data instanceof Buffer);
          assert.equal(0xC3, data[0]);
          assert.equal(0xA6, data[1]);
          done();
        });
      });
      it('should support other encodings', (done) => {
        const text = 'test æ!';
        const term = new UnixTerminal(null, ['-c', 'echo "' + text + '"'], {
          encoding: 'base64'
        });
        let buffer = '';
        term.on('data', (data) => {
          assert.equal(typeof data, 'string');
          buffer += data;
        });
        term.on('exit', () => {
          assert.equal(new Buffer(buffer, 'base64').toString().replace('\r', '').replace('\n', ''), text);
          done();
        });
      });
    });

    describe('open', () => {
      let term: UnixTerminal;

      afterEach(() => {
        if (term) {
          term.slave.destroy();
          term.master.destroy();
        }
      });

      it('should open a pty with access to a master and slave socket', (done) => {
        let doneCalled = false;
        term = UnixTerminal.open({});

        let slavebuf = '';
        term.slave.on('data', (data) => {
          slavebuf += data;
        });

        let masterbuf = '';
        term.master.on('data', (data) => {
          masterbuf += data;
        });

        (<any>pollUntil)(() => {
          if (masterbuf === 'slave\r\nmaster\r\n' && slavebuf === 'master\n') {
            done();
            return true;
          }
          return false;
        }, [], 200, 10);

        term.slave.write('slave\n');
        term.master.write('master\n');
      });
    });
    describe('signals in parent and child - TEST SHOULD NOT WITH THIS LINE', function(): void {
      it('SIGINT', function(done): void {
        let pHandlerCalled = 0;
        // tricky one: we have to remove all SIGINT listeners
        // so mocha will not stop here due to some other listener
        const listeners = process.listeners('SIGINT');
        const handleSigInt = function(h: any): any {
          return function(): void {
              pHandlerCalled += 1;
              process.removeListener('SIGINT', h);
              for (let i = 0; i < listeners.length; ++i) {
                process.on('SIGINT', listeners[i]);
              }
          }
        };
        process.removeAllListeners('SIGINT');
        process.on('SIGINT', handleSigInt(handleSigInt));

        const term = new UnixTerminal('node', [ '-e', `
          process.on('SIGINT', () => {
            console.log('SIGINT in child');
          });
          console.log('ready');
          setTimeout(()=>null, 200);`
        ]);
        let buffer = '';
        term.on('data', (data) => {
          if (data === 'ready\r\n') {
            process.kill(process.pid, 'SIGINT');
            term.kill('SIGINT');
          } else {
            buffer += data;
          }
        });
        term.on('exit', () => {
          // should have called both handlers
          assert.equal(pHandlerCalled, 1);
          assert.equal(buffer, 'SIGINT in child\r\n');
          done();
        });
      });
      it('SIGHUP (child only)', function(done): void {
        const term = new UnixTerminal('node', [ '-e', `
        console.log('ready');
        setTimeout(()=>console.log('timeout'), 200);`
        ]);
        let buffer = '';
        term.on('data', (data) => {
          if (data === 'ready\r\n') {
            term.kill();
          } else {
            buffer += data;
          }
        });
        term.on('exit', () => {
          // no timeout in buffer
          assert.equal(buffer, '');
          done();
        });
      });
      it('SIGUSR1', function(done): void {
        let pHandlerCalled = 0;
        const handleSigUsr = function(h: any): any {
          return function(): void {
            pHandlerCalled += 1;
            process.removeListener('SIGUSR1', h);
          }
        };
        process.on('SIGUSR1', handleSigUsr(handleSigUsr));

        const term = new UnixTerminal('node', [ '-e', `
        process.on('SIGUSR1', () => {
          console.log('SIGUSR1 in child');
        });
        console.log('ready');
        setTimeout(()=>null, 200);`
        ]);
        let buffer = '';
        term.on('data', (data) => {
          if (data === 'ready\r\n') {
            process.kill(process.pid, 'SIGUSR1');
            term.kill('SIGUSR1');
          } else {
            buffer += data;
          }
        });
        term.on('exit', () => {
          // should have called both handlers and only once
          assert.equal(pHandlerCalled, 1);
          assert.equal(buffer, 'SIGUSR1 in child\r\n');
          done();
        });
      });
    });
  });
}
