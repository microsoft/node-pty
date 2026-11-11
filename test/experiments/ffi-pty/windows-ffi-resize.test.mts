import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  classifyWindowsVersion,
  detectWindowsVersion,
} from "../../../experiments/ffi-pty/windows-version.mts";

const modern =
  process.platform === "win32" && classifyWindowsVersion(detectWindowsVersion()) === "ffi";

test(
  "direct FFI resize stays responsive while ConPTY output is backpressured",
  { skip: !modern, timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ffi-pty-resize-probe-"));
    const report = join(dir, "backpressure.txt");
    const probePath = fileURLToPath(new URL("./windows-ffi-resize-probe.mts", import.meta.url));
    const probe = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-ffi",
        "--experimental-strip-types",
        probePath,
        report,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    let sawBurst = false;
    let sawAckStall = false;
    let sawCancelling = false;
    let sawDone = false;
    let sawCancelled = false;
    let heartbeats = 0;
    let lastHeartbeat = Date.now();
    let timeout: NodeJS.Timeout | undefined;
    const armDeadline = (ms: number) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        probe.kill();
        rejectProbe(new Error(`Resize probe exceeded its ${ms} ms deadline`));
      }, ms);
    };
    let rejectProbe!: (error: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      rejectProbe = reject;
      const watchdog = setInterval(() => {
        if (sawBurst && Date.now() - lastHeartbeat > 2500) {
          probe.kill();
          clearInterval(watchdog);
          reject(new Error("Probe heartbeat stopped during resize stress"));
        }
      }, 100);
      armDeadline(30000);
      const onLine = (line: string) => {
        output += `${line}\n`;
        if (line.startsWith("BURST ")) {
          sawBurst = true;
          const count = Number(line.split(" ")[1]);
          armDeadline(count * 10 + 20000);
        } else if (line.startsWith("ACKSTALL ")) sawAckStall = true;
        else if (line === "CANCELLING") sawCancelling = true;
        else if (line === "HEARTBEAT") {
          heartbeats++;
          lastHeartbeat = Date.now();
        } else if (line === "CANCELLED") sawCancelled = true;
        else if (line === "DONE") sawDone = true;
      };
      let stdout = "";
      probe.stdout.setEncoding("utf8");
      probe.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      });
      probe.stderr.setEncoding("utf8");
      probe.stderr.on("data", (chunk: string) => (errors += chunk));
      probe.once("error", reject);
      probe.once("close", (code) => {
        clearInterval(watchdog);
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`Probe exited with ${code}.\n${output}\n${errors}`));
        else resolve();
      });
    });
    try {
      await stopped;
      assert.ok(sawBurst, `Probe did not reach the resize burst.\n${output}\n${errors}`);
      assert.ok(
        sawAckStall,
        `Resize ACKs never stalled under output backpressure.\n${output}\n${errors}`,
      );
      assert.ok(
        sawCancelling,
        `Probe did not exercise cancellation during resize stress.\n${output}\n${errors}`,
      );
      assert.ok(
        sawCancelled,
        `Worker did not clean up after stress cancellation.\n${output}\n${errors}`,
      );
      assert.ok(sawDone, `Probe did not finish its cleanup.\n${output}\n${errors}`);
      assert.equal(errors, "", `Probe reported stress errors.\n${output}`);
      assert.ok(heartbeats >= 3, `Only ${heartbeats} heartbeats ran during the resize burst`);
    } finally {
      if (probe.exitCode === null) probe.kill();
      await new Promise<void>((resolve) => {
        if (probe.exitCode !== null) return resolve();
        probe.once("close", () => resolve());
      });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
