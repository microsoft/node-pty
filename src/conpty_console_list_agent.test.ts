/**
 * Copyright (c) 2024, Microsoft Corporation (MIT License).
 */

import * as assert from 'assert';
import * as path from 'path';
import { fork } from 'child_process';

if (process.platform === 'win32') {
  describe('conpty_console_list_agent', () => {
    it('should gracefully handle AttachConsole failure for a dead PID', (done) => {
      const agentPath = path.join(__dirname, 'conpty_console_list_agent');
      const deadPid = 999999;

      const agent = fork(agentPath, [deadPid.toString()]);

      agent.on('message', (message: { consoleProcessList: number[] }) => {
        // When AttachConsole fails, the agent should fall back to returning
        // just the shell PID rather than crashing.
        assert.deepStrictEqual(message.consoleProcessList, [deadPid]);
        done();
      });

      agent.on('exit', (code) => {
        if (code !== 0) {
          done(new Error(`Agent exited with code ${code}, expected graceful fallback`));
        }
      });
    });
  });
}
