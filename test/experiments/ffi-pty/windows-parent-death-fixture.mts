import { createBackend } from "../../../experiments/ffi-pty/windows.mts";

const reportFile = process.argv[2];
if (!reportFile) throw new Error("missing report file path");
const script = `
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.writeFileSync(process.env.FFI_PTY_REPORT, JSON.stringify({ pid: process.pid, brokerPid: process.ppid, descendantPid: descendant.pid }));
  setInterval(() => {}, 1000);
`;
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
env.FFI_PTY_REPORT = reportFile;
const backend = await createBackend({
  file: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  env,
  cols: 80,
  rows: 24,
});
backend.readable.resume();
process.send?.({ type: "started", pid: backend.pid });
