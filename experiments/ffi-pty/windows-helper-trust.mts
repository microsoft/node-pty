import { execFile } from "node:child_process";
import { dlopen } from "node:ffi";
import { win32 as path } from "node:path";
import { promisify } from "node:util";
import { helperExecutablePath } from "./windows-helper.mts";
import { helperPublisherPolicy, type HelperPublisherPolicy } from "./windows-helper-publisher.mts";
import { lockWindowsHelper, type WindowsHelperLock } from "./windows-helper-lock.mts";
import { sniffPeCertificate } from "./windows-helper-pe.mts";

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 5000;
const POWERSHELL_MAX_BUFFER = 32 * 1024;
const SYSTEM_DIRECTORY_CAPACITY = 32768;
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sig = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $env:NODE_PTY_FFI_HELPER_PATH
$subject = ''
$issuer = ''
if ($null -ne $sig.SignerCertificate) {
  $subject = $sig.SignerCertificate.Subject
  $issuer = $sig.SignerCertificate.Issuer
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[ordered]@{ status = [string]$sig.Status; subject = $subject; issuer = $issuer } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
`;

export interface AuthenticodeResult {
  status: string;
  subject: string;
  issuer: string;
}

export interface SystemDirectoryBindings {
  GetSystemDirectoryW(buffer: Buffer, size: number): number;
}

export type HelperVerification =
  | { kind: "node"; reason: string }
  | { kind: "native"; path: string; subject: string };

export type AuthenticodeVerifier = (
  path: string,
  policy: HelperPublisherPolicy,
) => Promise<AuthenticodeResult>;

export interface HelperTrustDependencies {
  sniff(path: string): { present: boolean; reason: string };
  lock(path: string): WindowsHelperLock;
  retain(lock: WindowsHelperLock): void;
}

export function releaseHelperLock(lock: WindowsHelperLock): void {
  try {
    lock.release();
  } catch {
    // Verification failures must still fall back to the Node broker.
  }
}

const retainedHelperLocks: WindowsHelperLock[] = [];
let verifiedHelperPromise: Promise<HelperVerification> | undefined;
let systemDirectoryBindings: SystemDirectoryBindings | undefined;

export function nodeHelper(reason: string): HelperVerification {
  return { kind: "node", reason };
}

export function classifyAuthenticodeResult(
  helperPath: string,
  policy: HelperPublisherPolicy,
  signature: AuthenticodeResult,
): HelperVerification {
  if (!policy.subject) return nodeHelper("no helper publisher is configured");
  if (signature.status !== "Valid")
    return nodeHelper(`helper signature status is ${signature.status}`);
  if (signature.subject !== policy.subject)
    return nodeHelper("helper signer subject does not match policy");
  if (policy.issuer !== undefined && signature.issuer !== policy.issuer) {
    return nodeHelper("helper signer issuer does not match policy");
  }
  return { kind: "native", path: helperPath, subject: signature.subject };
}

export function loadSystemDirectoryBindings(): SystemDirectoryBindings {
  if (!systemDirectoryBindings) {
    systemDirectoryBindings = dlopen("kernel32.dll", {
      GetSystemDirectoryW: { arguments: ["pointer", "uint32"], return: "uint32" },
    }).functions as unknown as SystemDirectoryBindings;
  }
  return systemDirectoryBindings;
}

export function readSystemDirectory(native = loadSystemDirectoryBindings()): string {
  const buffer = Buffer.alloc(SYSTEM_DIRECTORY_CAPACITY * 2);
  const length = native.GetSystemDirectoryW(buffer, SYSTEM_DIRECTORY_CAPACITY);
  if (!length || length >= SYSTEM_DIRECTORY_CAPACITY) throw new Error("GetSystemDirectoryW failed");
  const directory = buffer.toString("utf16le", 0, length * 2);
  if (!path.isAbsolute(directory))
    throw new Error("GetSystemDirectoryW returned a non-absolute path");
  return path.normalize(directory);
}

export function systemPowerShellPath(readDirectory: () => string = readSystemDirectory): string {
  const systemDirectory = readDirectory();
  if (!path.isAbsolute(systemDirectory)) throw new Error("System directory is not absolute");
  return path.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function buildAuthenticodeVerifierEnv(
  source: NodeJS.ProcessEnv,
  helperPath: string,
  readDirectory: () => string = readSystemDirectory,
): NodeJS.ProcessEnv {
  const systemDirectory = readDirectory();
  if (!path.isAbsolute(systemDirectory)) throw new Error("System directory is not absolute");
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ["TEMP", "TMP"].includes(key.toUpperCase()))
      environment[key] = value;
  }
  const systemRoot = path.dirname(systemDirectory);
  environment.SystemRoot = systemRoot;
  environment.WINDIR = systemRoot;
  environment.PSModulePath = path.join(systemDirectory, "WindowsPowerShell", "v1.0", "Modules");
  environment.NODE_PTY_FFI_HELPER_PATH = helperPath;
  return environment;
}

export async function runPowerShellAuthenticodeVerifier(
  helperPath: string,
  policy: HelperPublisherPolicy,
): Promise<AuthenticodeResult> {
  const systemDirectory = readSystemDirectory();
  const trustedDirectory = () => systemDirectory;
  const shell = systemPowerShellPath(trustedDirectory);
  const env = buildAuthenticodeVerifierEnv(process.env, helperPath, trustedDirectory);
  const { stdout } = await execFileAsync(
    shell,
    ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
    {
      env,
      timeout: POWERSHELL_TIMEOUT_MS,
      maxBuffer: POWERSHELL_MAX_BUFFER,
      windowsHide: true,
      encoding: "utf8",
    },
  );
  const result = JSON.parse(String(stdout).trim()) as Partial<AuthenticodeResult>;
  if (
    typeof result.status !== "string" ||
    typeof result.subject !== "string" ||
    typeof result.issuer !== "string"
  ) {
    throw new Error("PowerShell returned an invalid Authenticode result");
  }
  return { status: result.status, subject: result.subject, issuer: result.issuer };
}

export async function verifyHelperAtPath(
  helperPath: string,
  policy: HelperPublisherPolicy,
  verifier: AuthenticodeVerifier = runPowerShellAuthenticodeVerifier,
  dependencies: Partial<HelperTrustDependencies> = {},
): Promise<HelperVerification> {
  if (!policy.subject) return nodeHelper("no helper publisher is configured");
  let lock: WindowsHelperLock | undefined;
  try {
    const sniff = (dependencies.sniff ?? sniffPeCertificate)(helperPath);
    if (!sniff.present) return nodeHelper(sniff.reason);
    lock = (dependencies.lock ?? lockWindowsHelper)(helperPath);
    const signature = await verifier(lock.path, policy);
    const result = classifyAuthenticodeResult(lock.path, policy, signature);
    if (result.kind === "native")
      (dependencies.retain ?? ((item) => retainedHelperLocks.push(item)))(lock);
    else releaseHelperLock(lock);
    return result;
  } catch (error) {
    if (lock) releaseHelperLock(lock);
    return nodeHelper(`helper verification failed: ${String(error)}`);
  }
}

export function getVerifiedHelper(): Promise<HelperVerification> {
  if (!verifiedHelperPromise) {
    verifiedHelperPromise = Promise.resolve()
      .then(async () => {
        if (!helperPublisherPolicy.subject) return nodeHelper("no helper publisher is configured");
        let helperPath: string;
        try {
          helperPath = helperExecutablePath();
        } catch (error) {
          return nodeHelper(`native helper is unavailable: ${String(error)}`);
        }
        return verifyHelperAtPath(helperPath, helperPublisherPolicy);
      })
      .catch((error) => nodeHelper(`native helper verification failed: ${String(error)}`));
  }
  return verifiedHelperPromise;
}
