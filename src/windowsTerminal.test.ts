/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as fs from 'fs';
import * as assert from 'assert';
import { WindowsTerminal } from './windowsTerminal';
import { IWindowsPtyForkOptions } from './interfaces';
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

      describe('parent window', () => {
        const user32 = `Add-Type -Namespace NodePtyTest -Name W -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport("user32.dll")] public static extern bool EnableWindow(IntPtr h, bool e); [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowExW(int ex, string cls, string title, int style, int x, int y, int w, int h, IntPtr owner, IntPtr menu, IntPtr inst, IntPtr param);'`;

        function scriptArgs(...lines: string[]): string {
          return `-NoProfile -NonInteractive -EncodedCommand ${Buffer.from([user32, ...lines].join('; '), 'utf16le').toString('base64')}`;
        }

        // Prints the console window and GetAncestor(GetConsoleWindow(), GA_ROOTOWNER), which is the
        // parent MSAL/WAM uses for sign-in dialogs.
        function rootOwnerArgs(delayMs: number, keepAliveSeconds: number = 0): string {
          return scriptArgs(
            `Start-Sleep -Milliseconds ${delayMs}`,
            `$c = [NodePtyTest.W]::GetConsoleWindow()`,
            `Write-Host ('console=' + $c.ToInt64() + ' rootOwner=' + [NodePtyTest.W]::GetAncestor($c, 3).ToInt64() + ' end')`,
            `Start-Sleep -Seconds ${keepAliveSeconds}`
          );
        }

        // Disabling the root owner and exiting stands in for a modal dialog whose process dies.
        function disableRootOwnerArgs(): string {
          return scriptArgs(
            `$o = [NodePtyTest.W]::GetAncestor([NodePtyTest.W]::GetConsoleWindow(), 3)`,
            `[void][NodePtyTest.W]::EnableWindow($o, $false)`,
            `Write-Host ('enabled=' + [NodePtyTest.W]::IsWindowEnabled($o) + ' end')`
          );
        }

        const started: Array<{ exited: Promise<void>, kill: () => void }> = [];

        function startPty(file: string, args: string | string[], options: IWindowsPtyForkOptions = {}): WindowsTerminal {
          const term = new WindowsTerminal(file, args, { useConptyDll, ...options });
          let hasExited = false;
          const exited = new Promise<void>(resolve => term.once('exit', () => {
            hasExited = true;
            resolve();
          }));
          started.push({
            exited,
            kill: () => {
              if (!hasExited) {
                term.kill();
              }
            }
          });
          return term;
        }

        // Wait for every pty to exit, even after a failed test: exiting while a conout worker still
        // flushes its pipe can hang mocha.
        afterEach(async function (): Promise<void> {
          this.timeout(30000);
          const ptys = started.splice(0);
          ptys.forEach(pty => pty.kill());
          await Promise.all(ptys.map(pty => pty.exited));
        });

        function readOutput(term: WindowsTerminal, pattern: RegExp): Promise<RegExpExecArray> {
          return new Promise(resolve => {
            let output = '';
            term.on('data', (data) => {
              output += data;
              const match = pattern.exec(output);
              if (match) {
                resolve(match);
              }
            });
          });
        }

        async function readWindows(term: WindowsTerminal): Promise<{ console: number, rootOwner: number }> {
          const match = await readOutput(term, /console=(-?\d+) rootOwner=(-?\d+) end/);
          return { console: parseInt(match[1], 10), rootOwner: parseInt(match[2], 10) };
        }

        // Another pty's hidden top-level console window stands in for the host app's window.
        async function startHostWindow(): Promise<number> {
          return (await readWindows(startPty('powershell.exe', rootOwnerArgs(0, 60)))).console;
        }

        // Re-enabling happens off the exit path, so wait up to waitMs for the window to be enabled.
        async function readEnabled(hwnd: number, waitMs: number): Promise<string> {
          const checker = startPty('powershell.exe', scriptArgs(
            `$h = [IntPtr]${hwnd}`,
            `for ($i = 0; $i -lt ${waitMs / 100} -and -not [NodePtyTest.W]::IsWindowEnabled($h); $i++) { Start-Sleep -Milliseconds 100 }`,
            `Write-Host ('enabled=' + [NodePtyTest.W]::IsWindowEnabled($h) + ' end')`
          ));
          return (await readOutput(checker, /enabled=(\w+) end/))[1];
        }

        async function disableParentAndExit(parent: number, options: IWindowsPtyForkOptions): Promise<void> {
          const term = startPty('powershell.exe', disableRootOwnerArgs(), { conptyParentWindow: parent, ...options });
          const exited = new Promise<void>(resolve => term.once('exit', () => resolve()));
          assert.strictEqual((await readOutput(term, /enabled=(\w+) end/))[1], 'False');
          await exited;
        }

        it('should make conptyParentWindow the owner of the console window before the shell starts', async function (): Promise<void> {
          this.timeout(60000);
          const hostWindow = await startHostWindow();
          const windows = await readWindows(startPty('powershell.exe', rootOwnerArgs(0), { conptyParentWindow: hostWindow }));
          assert.strictEqual(windows.rootOwner, useConptyDll ? hostWindow : windows.console);
        });

        it('should change the owner when setParentWindow is called while the shell runs', async function (): Promise<void> {
          this.timeout(60000);
          const hostWindow = await startHostWindow();
          const term = startPty('powershell.exe', rootOwnerArgs(3000));
          let sent: boolean | undefined;
          // The first data event means the shell is running and conpty has been released.
          term.once('data', () => sent = term.setParentWindow(BigInt(hostWindow)));
          const windows = await readWindows(term);
          assert.strictEqual(sent, useConptyDll);
          assert.strictEqual(windows.rootOwner, useConptyDll ? hostWindow : windows.console);
        });

        it('should not send setParentWindow once the pseudoconsole is closed', async function (): Promise<void> {
          this.timeout(20000);
          const term = startPty('cmd.exe', []);
          const exited = new Promise<void>(resolve => term.once('exit', () => resolve()));
          await new Promise<void>(resolve => term.once('data', () => resolve()));
          term.kill();
          assert.strictEqual(term.setParentWindow(0), false);
          await exited;
          assert.strictEqual(term.setParentWindow(0), false);
        });

        it('should reject handles that are not safe integers or bigints that fit in 64 bits', () => {
          const invalid: Array<[number | bigint, RegExp]> = [
            [BigInt('18446744073709551616'), /does not fit in 64 bits/],
            [BigInt('-9223372036854775809'), /does not fit in 64 bits/],
            [1.5, /must be a safe integer/],
            [Number.MAX_SAFE_INTEGER + 1, /must be a safe integer/]
          ];
          // Validated before the pseudoconsole is created, so nothing is left behind
          for (const [handle, error] of invalid) {
            assert.throws(() => startPty('cmd.exe', [], { conptyParentWindow: handle }), error);
          }
          const term = startPty('cmd.exe', []);
          for (const [handle, error] of invalid) {
            assert.throws(() => term.setParentWindow(handle), error);
          }
        });

        it('should re-enable the parent window on exit when asked, if a dialog left it disabled', async function (): Promise<void> {
          if (!useConptyDll) {
            this.skip();
          }
          this.timeout(60000);
          const hostWindow = await startHostWindow();
          await disableParentAndExit(hostWindow, { conptyReenableParentWindowOnExit: true });
          assert.strictEqual(await readEnabled(hostWindow, 5000), 'True');
        });

        it('should leave the parent window disabled on exit unless asked to re-enable it', async function (): Promise<void> {
          if (!useConptyDll) {
            this.skip();
          }
          this.timeout(60000);
          const hostWindow = await startHostWindow();
          await disableParentAndExit(hostWindow, {});
          assert.strictEqual(await readEnabled(hostWindow, 3000), 'False');
        });

        it('should not re-enable the parent window while it still owns a visible window', async function (): Promise<void> {
          if (!useConptyDll) {
            this.skip();
          }
          this.timeout(60000);
          const hostWindow = await startHostWindow();
          // A visible off-screen window owned through a hidden proxy window, like a modal dialog
          // shown by another process.
          const dialog = startPty('powershell.exe', scriptArgs(
            `$proxy = [NodePtyTest.W]::CreateWindowExW(0x80, 'STATIC', 'proxy', 0x80000000, 0, 0, 1, 1, [IntPtr]${hostWindow}, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)`,
            `$dialog = [NodePtyTest.W]::CreateWindowExW(0x08000080, 'STATIC', 'dialog', 0x90000000, -32000, -32000, 1, 1, $proxy, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)`,
            `Write-Host ('dialog=' + $dialog.ToInt64() + ' end')`,
            `Start-Sleep -Seconds 60`
          ));
          assert.notStrictEqual((await readOutput(dialog, /dialog=(-?\d+) end/))[1], '0');
          await disableParentAndExit(hostWindow, { conptyReenableParentWindowOnExit: true });
          assert.strictEqual(await readEnabled(hostWindow, 3000), 'False');
        });
      });
      describe('Regression for #921', () => {
        it('should not crash with concurrent kills while resizing/clearing/reparenting', function (done) {
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
                try {
                  t.setParentWindow(0);
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
