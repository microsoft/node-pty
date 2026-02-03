/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as fs from 'fs';
import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import * as path from 'path';
import * as psList from 'ps-list';

interface IProcessState {
  // Whether the PID must exist or must not exist
  [pid: number]: boolean;
}

interface IWindowsProcessTreeResult {
  name: string;
  pid: number;
}

function pollForProcessState(desiredState: IProcessState, intervalMs: number = 100, timeoutMs: number = 2000): Promise<void> {
  return new Promise<void>(resolve => {
    let tries = 0;
    const interval = setInterval(() => {
      psList({ all: true }).then(ps => {
        let success = true;
        const pids = Object.keys(desiredState).map(k => parseInt(k, 10));
        console.log('expected pids', JSON.stringify(pids));
        pids.forEach(pid => {
          if (desiredState[pid]) {
            if (!ps.some(p => p.pid === pid)) {
              console.log(`pid ${pid} does not exist`);
              success = false;
            }
          } else {
            if (ps.some(p => p.pid === pid)) {
              console.log(`pid ${pid} still exists`);
              success = false;
            }
          }
        });
        if (success) {
          clearInterval(interval);
          resolve();
          return;
        }
        tries++;
        if (tries * intervalMs >= timeoutMs) {
          clearInterval(interval);
          const processListing = pids.map(k => `${k}: ${desiredState[k]}`).join('\n');
          assert.fail(`Bad process state, expected:\n${processListing}`);
          resolve();
        }
      });
    }, intervalMs);
  });
}

function pollForProcessTreeSize(pid: number, size: number, intervalMs: number = 100, timeoutMs: number = 2000): Promise<IWindowsProcessTreeResult[]> {
  return new Promise<IWindowsProcessTreeResult[]>(resolve => {
    let tries = 0;
    const interval = setInterval(() => {
      psList({ all: true }).then(ps => {
        const openList: IWindowsProcessTreeResult[] = [];
        openList.push(ps.filter(p => p.pid === pid).map(p => {
          return { name: p.name, pid: p.pid };
        })[0]);
        const list: IWindowsProcessTreeResult[] = [];
        while (openList.length) {
          const current = openList.shift()!;
          ps.filter(p => p.ppid === current.pid).map(p => {
            return { name: p.name, pid: p.pid };
          }).forEach(p => openList.push(p));
          list.push(current);
        }
        console.log('list', JSON.stringify(list));
        const success = list.length === size;
        if (success) {
          clearInterval(interval);
          resolve(list);
          return;
        }
        tries++;
        if (tries * intervalMs >= timeoutMs) {
          clearInterval(interval);
          assert.fail(`Bad process state, expected: ${size}, actual: ${list.length}`);
        }
      });
    }, intervalMs);
  });
}

if (process.platform === 'win32') {
  [false, true].forEach((useConptyDll) => {
    describe(`WindowsTerminal (useConptyDll = ${useConptyDll})`, () => {
      describe('kill', () => {
        it('should not crash parent process', function (done) {
          this.timeout(20000);
          const term = new WindowsTerminal('cmd.exe', [], { useConptyDll });
          term.on('exit', () => done());
          term.kill();
        });
        it('should kill the process tree', function (done: Mocha.Done): void {
          this.timeout(20000);
          const term = new WindowsTerminal('cmd.exe', [], { useConptyDll });
          const socket = (term as any)._socket;
          let started = false;
          const startPolling = (): void => {
            if (started) {
              return;
            }
            if (term.pid === 0) {
              setTimeout(startPolling, 50);
              return;
            }
            started = true;
            // Start sub-processes
            term.write('powershell.exe\r');
            term.write('node.exe\r');
            console.log('start poll for tree size');
            pollForProcessTreeSize(term.pid, 3, 500, 5000).then(list => {
              assert.strictEqual(list[0].name.toLowerCase(), 'cmd.exe');
              assert.strictEqual(list[1].name.toLowerCase(), 'powershell.exe');
              assert.strictEqual(list[2].name.toLowerCase(), 'node.exe');
              term.kill();
              const desiredState: IProcessState = {};
              desiredState[list[0].pid] = false;
              desiredState[list[1].pid] = false;
              desiredState[list[2].pid] = false;
              term.on('exit', () => {
                pollForProcessState(desiredState, 1000, 5000).then(() => {
                  done();
                }).catch(done);
              });
            }).catch(done);
          };

          if (term.pid > 0) {
            startPolling();
          } else {
            socket.once('ready_datapipe', () => setTimeout(startPolling, 50));
          }
        });
      });

      describe('pid', () => {
        it('should be 0 before ready and set after ready_datapipe (issue #763)', function (done) {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', '/c echo test', { useConptyDll });

          // pid may be 0 immediately after construction due to deferred connection
          const initialPid = term.pid;

          // Access internal socket to listen for ready_datapipe
          const socket = (term as any)._socket;
          socket.on('ready_datapipe', () => {
            // After ready_datapipe, pid should be set to a valid non-zero value
            setTimeout(() => {
              assert.notStrictEqual(term.pid, 0, 'pid should be set after ready_datapipe');
              assert.strictEqual(typeof term.pid, 'number', 'pid should be a number');
              // If initial was 0, it should now be different (proves the fix works)
              if (initialPid === 0) {
                assert.notStrictEqual(term.pid, initialPid, 'pid should be updated from initial value');
              }
              term.on('exit', () => done());
              term.kill();
            }, 100);
          });
        });
      });

      describe('resize', () => {
        it('should throw a non-native exception when resizing an invalid value', function(done) {
          this.timeout(20000);
          const term = new WindowsTerminal('cmd.exe', [], { useConptyDll });
          assert.throws(() => term.resize(-1, -1));
          assert.throws(() => term.resize(0, 0));
          assert.doesNotThrow(() => term.resize(1, 1));
          term.on('exit', () => {
            done();
          });
          term.kill();
        });
        it('should throw a non-native exception when resizing a killed terminal', function(done) {
          this.timeout(20000);
          const term = new WindowsTerminal('cmd.exe', [], { useConptyDll });
          (<any>term)._defer(() => {
            term.once('exit', () => {
              assert.throws(() => term.resize(1, 1));
              done();
            });
            term.destroy();
          });
        });
      });

      describe('Args as CommandLine', () => {
        it('should not fail running a file containing a space in the path', function (done) {
          this.timeout(10000);
          const spaceFolder = path.resolve(__dirname, '..', 'fixtures', 'space folder');
          if (!fs.existsSync(spaceFolder)) {
            fs.mkdirSync(spaceFolder);
          }

          const cmdCopiedPath = path.resolve(spaceFolder, 'cmd.exe');
          const data = fs.readFileSync(`${process.env.windir}\\System32\\cmd.exe`);
          fs.writeFileSync(cmdCopiedPath, data);

          if (!fs.existsSync(cmdCopiedPath)) {
            // Skip test if git bash isn't installed
            return;
          }
          const term = new WindowsTerminal(cmdCopiedPath, '/c echo "hello world"', { useConptyDll });
          let result = '';
          term.on('data', (data) => {
            result += data;
          });
          term.on('exit', () => {
            assert.ok(result.indexOf('hello world') >= 1);
            done();
          });
        });
      });

      describe('env', () => {
        it('should set environment variables of the shell', function (done) {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', '/C echo %FOO%', { useConptyDll, env: { FOO: 'BAR' }});
          let result = '';
          term.on('data', (data) => {
            result += data;
          });
          term.on('exit', () => {
            assert.ok(result.indexOf('BAR') >= 0);
            done();
          });
        });
      });

      describe('On close', () => {
        it('should return process zero exit codes', function (done) {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', '/C exit', { useConptyDll });
          term.on('exit', (code) => {
            assert.strictEqual(code, 0);
            done();
          });
        });

        it('should return process non-zero exit codes', function (done) {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', '/C exit 2', { useConptyDll });
          term.on('exit', (code) => {
            assert.strictEqual(code, 2);
            done();
          });
        });
      });

      describe('Write', () => {
        it('should accept input', function (done) {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', '', { useConptyDll });
          term.write('exit\r');
          term.on('exit', () => {
            done();
          });
        });
      });
    });
  });
}
