/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as fs from 'fs';
import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import * as path from 'path';
import * as psList from 'ps-list';
import { Worker } from 'worker_threads';
import { pollUntil } from './testUtils.test';

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

async function pollForProcessTree(pid: number, names: string[], intervalMs: number = 100, timeoutMs: number = 2000): Promise<IWindowsProcessTreeResult[]> {
  const deadline = Date.now() + timeoutMs;
  let list: IWindowsProcessTreeResult[] = [];
  do {
    const ps = await psList({ all: true });
    const root = ps.find(p => p.pid === pid);
    const openList = root ? [root] : [];
    list = [];
    while (openList.length) {
      const current = openList.shift()!;
      if (list.some(p => p.pid === current.pid)) {
        continue;
      }
      list.push({ name: current.name, pid: current.pid });
      openList.push(...ps.filter(p => p.ppid === current.pid));
    }
    // Shell startup may create extra helpers, and process-list order is unspecified.
    if (names.every(name => list.some(p => p.name.toLowerCase() === name))) {
      return list;
    }
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`Bad process tree, expected: ${names.join(', ')}, actual: ${JSON.stringify(list)}`);
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
        it('should stop the output worker after killing a quiet terminal', async function (): Promise<void> {
          this.timeout(10000);
          const term = new WindowsTerminal('cmd.exe', ['/d', '/q'], { useConptyDll });
          const worker: Worker = (term as any)._agent._conoutSocketWorker._worker;
          try {
            let receivedOutput = false;
            term.onData(() => receivedOutput = true);
            await pollUntil(() => receivedOutput, 5000, 20);
            // Let the initial prompt drain before killing a terminal with no pending output.
            await new Promise<void>(resolve => setTimeout(resolve, 100));
            term.kill();
            await pollUntil(() => worker.threadId === -1, 3000, 20).catch(() => {
              assert.fail('The output worker is still running after terminal disposal');
            });
          } finally {
            term.kill();
            await worker.terminate();
          }
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
            console.log('start poll for process tree');
            pollForProcessTree(term.pid, ['cmd.exe', 'powershell.exe', 'node.exe'], 500, 10000).then(list => {
              term.kill();
              const desiredState: IProcessState = {};
              for (const process of list) {
                desiredState[process.pid] = false;
              }
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

      describe('connect failure', () => {
        it('should emit exit instead of an uncaught exception when CreateProcessW fails', function (done) {
          this.timeout(10000);
          // Must exist (startProcess validates that) but not be a valid executable.
          const notAnExe = path.join(__dirname, '..', 'package.json');
          const term = new WindowsTerminal(notAnExe, [], { useConptyDll });
          term.on('exit', (code) => {
            assert.notStrictEqual(code, 0);
            assert.strictEqual(term.pid, 0);
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

      describe('Regression for #921', () => {
        it('should not crash with concurrent kills while resizing/clearing', function (done) {
          this.timeout(60000);
          const N = 30;
          const terms: WindowsTerminal[] = [];
          let ready = 0;
          let exited = 0;
          let spamInterval: NodeJS.Timeout | undefined;
          const cleanup = (err?: Error): void => {
            if (spamInterval) {
              clearInterval(spamInterval);
              spamInterval = undefined;
            }
            done(err);
          };
          const startRace = (): void => {
            spamInterval = setInterval(() => {
              for (const t of terms) {
                try {
                  t.resize(80 + Math.floor(Math.random() * 40), 24 + Math.floor(Math.random() * 20));
                } catch (e) { /* already exited */ }
                try {
                  t.clear();
                } catch (e) { /* already exited */ }
              }
            }, 1);
            for (const t of terms) {
              try { t.kill(); } catch (e) { /* */ }
            }
          };
          for (let i = 0; i < N; i++) {
            const t = new WindowsTerminal('cmd.exe', [], { useConptyDll });
            terms.push(t);
            let readied = false;
            t.on('data', () => {
              if (readied) return;
              readied = true;
              ready++;
              if (ready === N) {
                startRace();
              }
            });
            t.on('exit', () => {
              exited++;
              if (exited === N) {
                cleanup();
              }
            });
          }
        });
      });
    });
  });
}
