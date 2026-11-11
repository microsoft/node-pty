import { spawnPty } from "./pty.mts";

const check = [
  "const tty = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;",
  "console.log(tty ? 'PTY_OK' : 'PTY_MISSING');",
  "console.log('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows);",
  "process.exitCode = tty ? 0 : 1;",
].join(" ");

const pty = await spawnPty(process.execPath, ["-e", check]);
const subscription = pty.onData((data) => process.stdout.write(data));
try {
  const status = await pty.exited;
  console.log("\nexit", status);
  if (status.exitCode !== 0) process.exitCode = 1;
} finally {
  subscription.dispose();
  await pty.close();
}
