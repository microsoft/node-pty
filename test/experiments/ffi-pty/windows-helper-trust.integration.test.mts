import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { helperExecutablePath } from "../../../experiments/ffi-pty/windows-helper.mts";
import {
  buildAuthenticodeVerifierEnv,
  readSystemDirectory,
  systemPowerShellPath,
  verifyHelperAtPath,
} from "../../../experiments/ffi-pty/windows-helper-trust.mts";

const execFileAsync = promisify(execFile);
const SIGN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
$pkiModule = Join-Path $PSHOME 'Modules\PKI\PKI.psd1'
[Console]::Error.WriteLine('[trust-test] importing certificate modules')
Import-Module -Name $securityModule -ErrorAction Stop
Import-Module -Name $pkiModule -ErrorAction Stop
$subject = $env:NODE_PTY_TEST_CERT_SUBJECT
[Console]::Error.WriteLine('[trust-test] creating ephemeral code-signing certificate')
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddDays(2)
try {
  [Console]::Error.WriteLine('[trust-test] exporting temporary certificate')
  Export-Certificate -Cert $cert -FilePath $env:NODE_PTY_TEST_CERT_FILE | Out-Null
  [Console]::Error.WriteLine('[trust-test] adding trust to disposable runner LocalMachine Root')
  Import-Certificate -FilePath $env:NODE_PTY_TEST_CERT_FILE -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
  [Console]::Error.WriteLine('[trust-test] signing helper executable')
  $signed = Set-AuthenticodeSignature -FilePath $env:NODE_PTY_TEST_HELPER -Certificate $cert -HashAlgorithm SHA256
  if ([string]$signed.Status -ne 'Valid') { throw "Signing failed: $($signed.Status)" }
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [ordered]@{ subject = $cert.Subject; issuer = $cert.Issuer; thumbprint = $cert.Thumbprint } | ConvertTo-Json -Compress
} catch {
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
  throw
}
`;

const CLEANUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
$pkiModule = Join-Path $PSHOME 'Modules\PKI\PKI.psd1'
[Console]::Error.WriteLine('[trust-test] importing certificate modules for cleanup')
Import-Module -Name $securityModule -ErrorAction Stop
Import-Module -Name $pkiModule -ErrorAction Stop
$thumbprint = $env:NODE_PTY_TEST_CERT_THUMBPRINT
$subject = $env:NODE_PTY_TEST_CERT_SUBJECT
foreach ($store in @('Cert:\CurrentUser\My', 'Cert:\LocalMachine\Root')) {
  $certificates = Get-ChildItem -LiteralPath $store | Where-Object {
    $_.Subject -eq $subject -or ($thumbprint -and $_.Thumbprint -eq $thumbprint)
  }
  foreach ($cert in $certificates) {
    if ($store -eq 'Cert:\CurrentUser\My') {
      Remove-Item -LiteralPath "$store\$($cert.Thumbprint)" -DeleteKey -Force
    } else {
      Remove-Item -LiteralPath "$store\$($cert.Thumbprint)" -Force
    }
  }
}
`;

interface TestCertificate {
  subject: string;
  issuer: string;
  thumbprint: string;
}

async function runPowerShell(script: string, variables: Record<string, string>): Promise<string> {
  const env = buildAuthenticodeVerifierEnv(process.env, "", readSystemDirectory);
  Object.assign(env, variables);
  try {
    const { stdout } = await execFileAsync(
      systemPowerShellPath(readSystemDirectory),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env, windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024, encoding: "utf8" },
    );
    return String(stdout).trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(`${failure.message}${failure.stderr ? `\nPowerShell stderr:\n${failure.stderr}` : ""}`, {
      cause: error,
    });
  }
}

export async function timedStage<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await operation();
  } finally {
    process.stderr.write(`[trust-test] ${name} completed in ${Date.now() - started}ms\n`);
  }
}

export function canRunMachineCertificateIntegration(
  platform = process.platform,
  actions = process.env.GITHUB_ACTIONS,
  runner = process.env.RUNNER_ENVIRONMENT,
): boolean {
  return platform === "win32" && actions === "true" && runner === "github-hosted";
}

test("machine certificate integration is limited to GitHub-hosted Windows runners", () => {
  assert.equal(canRunMachineCertificateIntegration("win32", "true", "github-hosted"), true);
  assert.equal(canRunMachineCertificateIntegration("win32", "true", "self-hosted"), false);
  assert.equal(canRunMachineCertificateIntegration("win32", "false", "github-hosted"), false);
  assert.equal(canRunMachineCertificateIntegration("darwin", "true", "github-hosted"), false);
});

test(
  "verified signed helper is locked, wrong publisher falls back, and tampering is rejected",
  { skip: !canRunMachineCertificateIntegration(), timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "node-pty-helper-trust-"));
    const helper = join(directory, "helper.exe");
    const alternate = join(directory, "replacement.exe");
    const certificateFile = join(directory, "test.cer");
    const subject = `CN=Node Pty FFI Test ${process.pid}-${Date.now()}`;
    let certificate: TestCertificate | undefined;
    let retainedRelease: (() => void) | undefined;
    let testFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      copyFileSync(helperExecutablePath(), helper);
      writeFileSync(alternate, readFileSync(helper));
      const signOutput = await timedStage("sign helper", () => runPowerShell(SIGN_SCRIPT, {
        NODE_PTY_TEST_CERT_SUBJECT: subject,
        NODE_PTY_TEST_CERT_FILE: certificateFile,
        NODE_PTY_TEST_HELPER: helper,
      }));
      certificate = JSON.parse(signOutput) as TestCertificate;
      assert.equal(typeof certificate.thumbprint, "string");
      assert.equal(certificate.subject, subject);

      const approved = await timedStage("verify signed helper", () => verifyHelperAtPath(
        helper,
        { subject: certificate.subject, issuer: certificate.issuer },
        undefined,
        {
          retain: (lock) => {
            retainedRelease = () => lock.release();
          },
        },
      ));
      assert.equal(approved.kind, "native");
      if (approved.kind === "native") {
        assert.equal(approved.path.toLowerCase(), realpathSync.native(helper).toLowerCase());
        assert.equal(approved.subject, certificate.subject);
      }
      assert.ok(retainedRelease, "successful verification retains the helper lock");
      let writeHandle: number | undefined;
      try {
        writeHandle = openSync(helper, "r+");
      } catch {
        // The retained verification handle denies write sharing.
      }
      if (writeHandle !== undefined) {
        closeSync(writeHandle);
        assert.fail("retained helper lock allowed a write handle");
      }
      assert.throws(() => appendFileSync(helper, Buffer.from([0])));
      assert.throws(() => {
        // ReplaceFile/MoveFile must not replace a helper while verification is retained.
        renameSync(alternate, helper);
      });

      retainedRelease();
      retainedRelease = undefined;
      const rejectedPublisher = await timedStage("reject wrong publisher", () => verifyHelperAtPath(helper, {
        subject: `${certificate.subject}-wrong`,
        issuer: certificate.issuer,
      }));
      assert.equal(rejectedPublisher.kind, "node");

      const file = readFileSync(helper);
      const peOffset = file.readUInt32LE(0x3c);
      const sectionCount = file.readUInt16LE(peOffset + 6);
      const optionalSize = file.readUInt16LE(peOffset + 20);
      const firstSection = peOffset + 24 + optionalSize;
      assert.ok(sectionCount > 0, "signed helper has at least one PE section");
      const tamperOffset = file.readUInt32LE(firstSection + 20);
      assert.ok(tamperOffset > 0 && tamperOffset < file.length, "first section data is inside helper");
      const tamperHandle = openSync(helper, "r+");
      try {
        writeSync(tamperHandle, Buffer.from([file[tamperOffset]! ^ 1]), 0, 1, tamperOffset);
      } finally {
        closeSync(tamperHandle);
      }
      const tampered = await timedStage("reject tampered helper", () => verifyHelperAtPath(helper, {
        subject: certificate.subject,
        issuer: certificate.issuer,
      }));
      assert.equal(tampered.kind, "node");
      if (tampered.kind === "node") assert.match(tampered.reason, /HashMismatch/i);
    } catch (error) {
      testFailure = error;
    } finally {
      try {
        retainedRelease?.();
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (subject) {
        await timedStage("certificate cleanup", () => runPowerShell(CLEANUP_SCRIPT, {
          NODE_PTY_TEST_CERT_THUMBPRINT: certificate?.thumbprint ?? "",
          NODE_PTY_TEST_CERT_SUBJECT: subject,
        })).catch((error) => {
          cleanupFailures.push(error);
        });
      }
      try {
        if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (testFailure && cleanupFailures.length) {
      throw new AggregateError([testFailure, ...cleanupFailures], "trust test and cleanup failed", {
        cause: testFailure,
      });
    }
    if (testFailure) throw testFailure;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "trust test cleanup failed");
  },
);
