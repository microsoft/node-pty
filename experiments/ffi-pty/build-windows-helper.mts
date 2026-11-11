import { gzipSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = join(ROOT, "experiments", "ffi-pty", "native");

export function targetArchitecture(
  argv = process.argv.slice(2),
  env = process.env,
): "x64" | "arm64" {
  const requested =
    argv.find((arg) => arg.startsWith("--arch="))?.slice("--arch=".length) ??
    env.npm_config_arch ??
    env.ARCH ??
    process.arch;
  if (requested !== "x64" && requested !== "arm64") {
    throw new Error(`Windows helper supports x64 and arm64 targets; got ${requested}`);
  }
  return requested;
}

export function findVsDevCmd(env: NodeJS.ProcessEnv): string {
  const root = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  try {
    const result = execFileSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-find",
        "Common7\\Tools\\VsDevCmd.bat",
      ],
      { encoding: "utf8", windowsHide: true },
    )
      .trim()
      .split(/\r?\n/);
    const path = result.find((entry) => entry.toLowerCase().endsWith("vsdevcmd.bat"));
    if (path) return path;
  } catch (error) {
    throw new Error(`Unable to locate Visual Studio C++ tools with vswhere: ${String(error)}`);
  }
  throw new Error("Visual Studio C++ tools are missing (VsDevCmd.bat was not found)");
}

export function quoteResponsePath(value: string): string {
  if (value.includes('"')) throw new Error("build paths may not contain quotes");
  return `"${value}"`;
}

export function buildHelper(arch = targetArchitecture(), env = process.env): string {
  if (process.platform !== "win32")
    throw new Error("The Win32 helper can only be built on Windows");
  const hostArch = process.arch === "arm64" ? "arm64" : "x64";
  const outputDir = join(ROOT, "build", "ffi-pty", `win32-${arch}`);
  mkdirSync(outputDir, { recursive: true });
  const executable = join(outputDir, "helper.exe");
  const response = join(tmpdir(), `pty-helper-${process.pid}-${arch}.rsp`);
  const arguments_ = [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/W4",
    "/WX",
    "/O2",
    "/MT",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_WIN32_WINNT=0x0A00",
    "/DWINVER=0x0A00",
    `/Fe${quoteResponsePath(executable)}`,
    `/Fo${quoteResponsePath(`${outputDir}/`)}`,
    quoteResponsePath(join(SOURCE, "windows_helper.cpp")),
    quoteResponsePath(join(SOURCE, "windows_helper_protocol.cpp")),
  ];
  writeFileSync(response, `${arguments_.join("\r\n")}\r\n`, "utf8");
  const vsDevCmd = findVsDevCmd(env);
  const command = `call "${vsDevCmd}" -no_logo -arch=${arch} -host_arch=${hostArch} && cl.exe @"${response}"`;
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", command], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`MSVC helper build failed with exit code ${result.status}`);

  const bytes = statSync(executable).size;
  const compressedBytes = gzipSync(readFileSync(executable), { level: 9 }).length;
  const summary = `Windows helper (${arch}): ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB), gzip ${compressedBytes} bytes (${(compressedBytes / 1024).toFixed(1)} KiB) at ${executable}`;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY)
    writeFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
