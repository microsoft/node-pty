/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 *
 * This module fetches the console process list for a particular PID. It must be
 * called from a different process (child_process.fork) as there can only be a
 * single console attached to a process.
 */

import { loadNativeModule } from './utils';

const getConsoleProcessList = loadNativeModule('conpty_console_list').module.getConsoleProcessList;
const shellPid = parseInt(process.argv[2], 10);
try {
  const consoleProcessList = getConsoleProcessList(shellPid);
  process.send!({ consoleProcessList });
} catch {
  // AttachConsole can fail if the shell process has already exited.
  // Fall back to returning just the shell PID, matching the timeout
  // fallback behavior in windowsPtyAgent.ts.
  process.send!({ consoleProcessList: [shellPid] });
}
process.exit(0);
