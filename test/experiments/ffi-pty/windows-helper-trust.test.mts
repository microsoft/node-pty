import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyAuthenticodeResult,
  buildAuthenticodeVerifierEnv,
  getVerifiedHelper,
  runPowerShellAuthenticodeVerifier,
  systemPowerShellPath,
  verifyHelperAtPath,
  type AuthenticodeResult,
} from "../../../experiments/ffi-pty/windows-helper-trust.mts";
import type { HelperPublisherPolicy } from "../../../experiments/ffi-pty/windows-helper-publisher.mts";
import type { WindowsHelperLock } from "../../../experiments/ffi-pty/windows-helper-lock.mts";

const policy: HelperPublisherPolicy = { subject: "CN=PTY Test", issuer: "CN=Test CA" };
const valid: AuthenticodeResult = {
  status: "Valid",
  subject: policy.subject,
  issuer: policy.issuer,
};

test("Authenticode trust requires exact valid status, subject, and configured issuer", () => {
  assert.deepEqual(classifyAuthenticodeResult("helper.exe", policy, valid), {
    kind: "native",
    path: "helper.exe",
    subject: policy.subject,
  });
  assert.equal(
    classifyAuthenticodeResult("helper.exe", policy, { ...valid, status: "HashMismatch" }).kind,
    "node",
  );
  assert.equal(
    classifyAuthenticodeResult("helper.exe", policy, { ...valid, subject: "CN=Other" }).kind,
    "node",
  );
  assert.equal(
    classifyAuthenticodeResult("helper.exe", policy, { ...valid, issuer: "CN=Other" }).kind,
    "node",
  );
  assert.equal(classifyAuthenticodeResult("helper.exe", { subject: "" }, valid).kind, "node");
});

test("empty default publisher policy caches Node fallback without inspecting a file", async () => {
  const first = getVerifiedHelper();
  assert.equal(first, getVerifiedHelper());
  assert.equal((await first).kind, "node");
});

test("PowerShell location and module path ignore caller SystemRoot and PSModulePath", () => {
  const trustedSystemDirectory = "C:\\Windows\\System32";
  const source = Object.assign(Object.create(null), {
    SystemRoot: "C:\\attacker\\root",
    WINDIR: "C:\\attacker\\windir",
    PSModulePath: "C:\\attacker\\modules",
    PATH: "C:\\attacker\\bin",
    TEMP: "C:\\temp",
  }) as NodeJS.ProcessEnv;
  const systemDirectory = () => trustedSystemDirectory;
  const env = buildAuthenticodeVerifierEnv(source, "C:\\trusted\\helper.exe", systemDirectory);
  assert.equal(
    systemPowerShellPath(systemDirectory),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.WINDIR, "C:\\Windows");
  assert.equal(env.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.equal(env.TEMP, "C:\\temp");
  assert.equal(env.PATH, undefined);
});

test("unsigned or unreadable helper exits before lock and verifier", async () => {
  let locks = 0;
  let verifications = 0;
  const result = await verifyHelperAtPath(
    "helper.exe",
    policy,
    async () => {
      verifications++;
      return valid;
    },
    {
      sniff: () => ({ present: false, reason: "missing certificate" }),
      lock: () => {
        locks++;
        throw new Error("must not lock");
      },
    },
  );
  assert.equal(result.kind, "node");
  assert.equal(locks, 0);
  assert.equal(verifications, 0);
});

test("positive verification retains the lock; failed verification releases it", async () => {
  let retained = 0;
  let released = 0;
  const makeLock = (): WindowsHelperLock => ({ path: "locked.exe", release: () => released++ });
  const deps = {
    sniff: () => ({ present: true, reason: "certificate table present" }),
    lock: () => makeLock(),
    retain: () => retained++,
  };
  assert.equal(
    (await verifyHelperAtPath("helper.exe", policy, async () => valid, deps)).kind,
    "native",
  );
  assert.equal(retained, 1);
  assert.equal(released, 0);
  const failure = await verifyHelperAtPath(
    "helper.exe",
    policy,
    async () => {
      throw new Error("bad signature");
    },
    deps,
  );
  assert.equal(failure.kind, "node");
  assert.equal(released, 1);
});

test(
  "missing helper falls back without invoking Authenticode",
  { skip: process.platform !== "win32" },
  async () => {
    let invoked = false;
    const result = await verifyHelperAtPath(
      "C:\\definitely-missing\\pty-helper.exe",
      policy,
      async () => {
        invoked = true;
        return valid;
      },
    );
    assert.equal(result.kind, "node");
    assert.equal(invoked, false);
  },
);

test(
  "PowerShell reports a real unsigned file as untrusted",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pty-unsigned-"));
    const file = join(directory, "unsigned.exe");
    writeFileSync(file, "unsigned helper fixture");
    try {
      const result = await runPowerShellAuthenticodeVerifier(file, policy);
      assert.notEqual(result.status, "Valid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
