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
let consoleProcessList: number[] = [];
if (shellPid > 0) {
	try {
		consoleProcessList = getConsoleProcessList(shellPid);
	} catch {
		// AttachConsole can fail if the process already exited or is invalid.
		consoleProcessList = [];
	}
}
process.send!({ consoleProcessList });
process.exit(0);
