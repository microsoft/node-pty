import { createInterface } from "node:readline";
import { closeSync, openSync } from "node:fs";

const mode = process.argv[2];
if (mode === "echo" && process.stdout.isTTY) {
  process.stdout.on("resize", () => {
    process.stdout.write(`RESIZED:${JSON.stringify(process.stdout.getWindowSize())}\n`);
  });
}
const info = {
  argv: process.argv.slice(3),
  cwd: process.cwd(),
  marker: process.env.TEST_MARKER ?? "",
  tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY],
  size: process.stdout.isTTY ? process.stdout.getWindowSize() : null,
  controllingTty:
    process.platform === "win32"
      ? null
      : (() => {
          const fd = openSync("/dev/tty", "r");
          closeSync(fd);
          return true;
        })(),
};
if (mode !== "large") process.stdout.write(`INFO:${JSON.stringify(info)}\n`);

if (mode === "exit") {
  process.stdout.write("BEFORE_EXIT\n");
  process.exit(Number(process.argv[3] ?? 0));
} else if (mode === "large") {
  const total = Number(process.argv[3]);
  const chunkSize = 32;
  const count = Math.ceil(total / chunkSize);
  const output = Array.from({ length: count }, (_, index) => {
    const size = Math.min(chunkSize, total - index * chunkSize);
    return `CHUNK:${String(index).padStart(4, "0")}:${"x".repeat(size)}\n`;
  }).join("");
  process.stdout.write(`${output}ENDLARGE\n`);
} else if (mode === "large-input") {
  const expected = Number(process.argv[3]);
  let received = 0;
  let nextHeartbeat = 64 * 1024;
  const reportProgress = () => {
    while (received >= nextHeartbeat) {
      process.stdout.write(`HEARTBEAT:${received}\n`);
      nextHeartbeat += 64 * 1024;
    }
    if (received >= expected) {
      process.stdout.write(`INPUT:${received}\n`);
      process.exit(0);
    }
  };
  if (typeof process.stdin.setRawMode !== "function") {
    throw new Error("large-input test requires raw TTY input");
  }
  process.stdin.setRawMode(true);
  process.stdin.on("data", (chunk: Buffer) => {
    received += chunk.length;
    reportProgress();
  });
  process.stdout.write("INPUT_READY\n");
} else if (mode === "echo") {
  const input = createInterface({ input: process.stdin });
  input.once("line", (line) => {
    process.stdout.write(
      `ECHO:${JSON.stringify(line)} SIZE:${JSON.stringify(process.stdout.getWindowSize())}\n`,
    );
    input.close();
  });
} else if (mode === "twoline") {
  const input = createInterface({ input: process.stdin });
  let count = 0;
  input.on("line", (line) => {
    process.stdout.write(`LINE:${++count}:${line}\n`);
    if (count === 2) input.close();
  });
} else if (mode === "ctrlc") {
  process.on("SIGINT", () => {
    process.stdout.write("INTERRUPTED\n");
    process.exit(23);
  });
  process.stdin.resume();
  process.stdout.write("CTRL_C_READY\n");
} else if (mode === "stall-input") {
  process.stdin.setRawMode?.(true);
  process.stdin.pause();
  process.stdout.write("STALL_READY\n");
  setInterval(() => {}, 1000);
} else if (mode === "winch") {
  process.on("SIGWINCH", () => {
    process.stdout.write(`WINCH:${JSON.stringify(process.stdout.getWindowSize())}\n`);
  });
  process.stdin.resume();
  process.stdout.write("WINCH_READY\n");
}
