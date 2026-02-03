/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

import * as assert from 'assert';
import { argsToCommandLine, WindowsPtyAgent } from './windowsPtyAgent';

function check(file: string, args: string | string[], expected: string): void {
  assert.equal(argsToCommandLine(file, args), expected);
}

if (process.platform === 'win32') {
  describe('argsToCommandLine', () => {
    describe('Plain strings', () => {
      it('doesn\'t quote plain string', () => {
        check('asdf', [], 'asdf');
      });
      it('doesn\'t escape backslashes', () => {
        check('\\asdf\\qwer\\', [], '\\asdf\\qwer\\');
      });
      it('doesn\'t escape multiple backslashes', () => {
        check('asdf\\\\qwer', [], 'asdf\\\\qwer');
      });
      it('adds backslashes before quotes', () => {
        check('"asdf"qwer"', [], '\\"asdf\\"qwer\\"');
      });
      it('escapes backslashes before quotes', () => {
        check('asdf\\"qwer', [], 'asdf\\\\\\"qwer');
      });
    });

    describe('Quoted strings', () => {
      it('quotes string with spaces', () => {
        check('asdf qwer', [], '"asdf qwer"');
      });
      it('quotes empty string', () => {
        check('', [], '""');
      });
      it('quotes string with tabs', () => {
        check('asdf\tqwer', [], '"asdf\tqwer"');
      });
      it('escapes only the last backslash', () => {
        check('\\asdf \\qwer\\', [], '"\\asdf \\qwer\\\\"');
      });
      it('doesn\'t escape multiple backslashes', () => {
        check('asdf \\\\qwer', [], '"asdf \\\\qwer"');
      });
      it('escapes backslashes before quotes', () => {
        check('asdf \\"qwer', [], '"asdf \\\\\\"qwer"');
      });
      it('escapes multiple backslashes at the end', () => {
        check('asdf qwer\\\\', [], '"asdf qwer\\\\\\\\"');
      });
    });

    describe('Multiple arguments', () => {
      it('joins arguments with spaces', () => {
        check('asdf', ['qwer zxcv', '', '"'], 'asdf "qwer zxcv" "" \\"');
      });
      it('array argument all in quotes', () => {
        check('asdf', ['"surounded by quotes"'], 'asdf \\"surounded by quotes\\"');
      });
      it('array argument quotes in the middle', () => {
        check('asdf', ['quotes "in the" middle'], 'asdf "quotes \\"in the\\" middle"');
      });
      it('array argument quotes near start', () => {
        check('asdf', ['"quotes" near start'], 'asdf "\\"quotes\\" near start"');
      });
      it('array argument quotes near end', () => {
        check('asdf', ['quotes "near end"'], 'asdf "quotes \\"near end\\""');
      });
    });

    describe('Args as CommandLine', () => {
      it('should handle empty string', () => {
        check('file', '', 'file');
      });
      it('should not change args', () => {
        check('file', 'foo bar baz', 'file foo bar baz');
        check('file', 'foo \\ba"r \baz', 'file foo \\ba"r \baz');
      });
    });

    describe('Real-world cases', () => {
      it('quotes within quotes', () => {
        check('cmd.exe', ['/c', 'powershell -noexit -command \'Set-location \"C:\\user\"\''], 'cmd.exe /c "powershell -noexit -command \'Set-location \\\"C:\\user\\"\'"');
      });
      it('space within quotes', () => {
        check('cmd.exe', ['/k', '"C:\\Users\\alros\\Desktop\\test script.bat"'], 'cmd.exe /k \\"C:\\Users\\alros\\Desktop\\test script.bat\\"');
      });
    });
  });

  describe('WindowsPtyAgent', () => {
    describe('connection timing (issue #763)', () => {
      it('should defer conptyNative.connect() until worker is ready', function (done) {
        this.timeout(10000);

        const term = new WindowsPtyAgent(
          'cmd.exe',
          '/c echo test',
          Object.keys(process.env).map(k => `${k}=${process.env[k]}`),
          process.cwd(),
          80,
          30,
          false,
          false,
          false
        );

        // The innerPid should be 0 initially since connect() is deferred
        // until the worker signals ready. This verifies the fix for #763.
        const initialPid = term.innerPid;

        // Wait for the connection to complete via ready_datapipe event
        term.outSocket.on('ready_datapipe', () => {
          // After worker is ready and connect() is called, innerPid should be set
          // Use a small delay to ensure _completePtyConnection has run
          setTimeout(() => {
            assert.notStrictEqual(term.innerPid, 0, 'innerPid should be set after worker is ready');
            assert.strictEqual(initialPid, 0, 'innerPid should have been 0 before worker was ready');
            term.kill();
            done();
          }, 100);
        });
      });

      it('should successfully spawn a process after deferred connection', function (done) {
        this.timeout(10000);

        const term = new WindowsPtyAgent(
          'cmd.exe',
          '/c echo hello',
          Object.keys(process.env).map(k => `${k}=${process.env[k]}`),
          process.cwd(),
          80,
          30,
          false,
          false,
          false
        );

        let output = '';
        term.outSocket.on('data', (data: string) => {
          output += data;
        });

        // Wait for process to complete and verify output
        setTimeout(() => {
          assert.ok(output.includes('hello'), `Expected output to contain "hello", got: ${output}`);
          term.kill();
          done();
        }, 2000);
      });

      it('should allow async work between construction and connection (non-blocking)', function (done) {
        this.timeout(10000);

        // Track the sequence of events to verify non-blocking behavior
        const events: string[] = [];

        const term = new WindowsPtyAgent(
          'cmd.exe',
          '/c echo test',
          Object.keys(process.env).map(k => `${k}=${process.env[k]}`),
          process.cwd(),
          80,
          30,
          false,
          false,
          false
        );

        events.push('constructor_returned');
        assert.strictEqual(term.innerPid, 0, 'innerPid should be 0 immediately after construction');

        // Schedule async work - this MUST run before ready_datapipe if constructor is non-blocking
        setImmediate(() => {
          events.push('setImmediate_ran');
          // innerPid might still be 0 or might be set by now, depending on timing
          // The key is that setImmediate ran, proving the event loop wasn't blocked
        });

        term.outSocket.on('ready_datapipe', () => {
          events.push('ready_datapipe');

          setTimeout(() => {
            events.push('final_check');

            // Verify the sequence: constructor returned, then async work could run
            assert.ok(events.includes('constructor_returned'), 'constructor should have returned');
            assert.ok(events.includes('setImmediate_ran'), 'setImmediate should have run (event loop not blocked)');
            assert.ok(events.indexOf('constructor_returned') < events.indexOf('setImmediate_ran'),
              'constructor should return before setImmediate runs');

            // Most importantly: innerPid should now be set
            assert.notStrictEqual(term.innerPid, 0, 'innerPid should be set after connection');

            term.kill();
            done();
          }, 100);
        });
      });
    });
  });
}
