/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 *
 * This module fetches the console process list for a particular PID. It must be
 * called from a different process (child_process.fork) as there can only be a
 * single console attached to a process.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const __non_webpack_require__ = require;
let getConsoleProcessList: any;
try {
  getConsoleProcessList = __non_webpack_require__('../build/Release/conpty_console_list.node').getConsoleProcessList;
} catch (err) {
  getConsoleProcessList = __non_webpack_require__('../build/Debug/conpty_console_list.node').getConsoleProcessList;
}

const shellPid = parseInt(process.argv[2], 10);
const consoleProcessList = getConsoleProcessList(shellPid);
process.send!({ consoleProcessList });
process.exit(0);
