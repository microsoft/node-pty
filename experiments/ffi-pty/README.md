# Cross-platform Node FFI PTY experiment

This opt-in experiment creates a PTY without a node-pty native addon. It requires Node.js 26.12.0 with `--experimental-ffi`. It is not imported by node-pty's public entry point and does not change the public `IPty` API.

## Try it

```sh
node --experimental-ffi experiments/ffi-pty/probe.mts
node --experimental-ffi --test test/experiments/ffi-pty/*.test.mts
```

The facade exports `spawnPty(file, args, options)`, which resolves to a PTY with `pid`, `cols`, `rows`, `onData`, `onExit`, `write`, `resize`, `kill`, `pause`, `resume`, `close`, and `exited`.

Supported spawn options are `cols` (80), `rows` (24), `cwd` (current directory), `env` (current environment), and UTF-8 `encoding`. A supplied `env` replaces the inherited environment; `TERM=xterm-256color` is added if absent. Dimensions must be 1–32767. Unknown options and non-UTF-8 encodings are rejected before a PTY is allocated.

This is a small experimental API, not full `IPty` parity. It does not support credentials such as `uid`/`gid`, pixel dimensions, ConPTY DLL or cursor-inheritance options, or encodings other than UTF-8.

## Platform paths

| Platform | Native path and current limit                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `openpty` and `posix_spawn` from `libSystem`; a Node bootstrap calls public `login_tty` then `execve` to set the controlling terminal; resize delegates to `/bin/stty`. |
| Linux    | glibc `openpty` and `posix_spawn`; requires glibc 2.34 or newer; resize delegates to `stty`.                                                                            |
| Windows  | System ConPTY APIs; requires Windows 10 version 1809 or Windows Server 2019 or newer.                                                                                   |

On Unix, `uv_poll_init` sets the PTY master nonblocking through a temporary libuv loop. The shared backend serializes writes, retries `EAGAIN` and `EINTR`, caps queued input at 8 MiB, and yields between 64 KiB writes. After child exit, it waits for output EOF for up to 1.5 seconds of unpaused time so inherited descriptors cannot hold exit open indefinitely. Explicitly pausing output suspends that budget; an unread stream still has the bounded timeout. Unix resize runs the system `stty` command; Windows uses ConPTY resize. ([libuv poll API](https://docs.libuv.org/en/v1.x/poll.html))

The implementation relies on Node's experimental and unsafe FFI interface ([Node.js FFI](https://nodejs.org/api/ffi.html)), Unix PTY and process APIs ([Apple `posix_spawn`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/posix_spawn.2.html), [Apple `login_tty`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/login_tty.3.html), [Linux `openpty`](https://www.man7.org/linux/man-pages/man3/openpty.3.html), [Linux `posix_spawn`](https://man7.org/linux/man-pages/man3/posix_spawn.3.html)), and Windows' [CreatePseudoConsole API](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole). Windows pseudoconsoles are a system facility; this experiment does not bundle a ConPTY DLL. The macOS bootstrap adds a Node startup before the target process. No performance or binary-size advantage has been measured.

Windows selects its implementation using the actual OS version from `RtlGetVersion`:

| System                                                                          | Implementation                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Windows 10 1809+, Windows 11 before 24H2, Server 2019/2022 (builds 17763–26099) | Node subprocess by default; verified native helper when available. |
| Windows 11 24H2+ and Server 2025 (build 26100+)                                 | FFI in an in-process worker; no helper executable needed.          |
| Before build 17763                                                              | Unsupported: ConPTY is unavailable.                                |

The helper process contains a [known handle leak in older system ConPTY implementations](https://github.com/microsoft/terminal/issues/17903#issuecomment-2343499050), because exiting it releases its handles. Build 26100 fixes that leak and makes [`ClosePseudoConsole` nonblocking](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole). All Windows paths use a kill-on-close job to clean up the target and its descendants. Modern Windows isolates synchronous ConPTY calls in a worker so blocked resize calls do not stall the main thread.

On affected Windows, the default helper runs with the installed Node executable. An optional C++ helper uses Win32 directly, without Node or its addon ABI. Automatic selection requires a valid Windows Authenticode signature matching the publisher specified by trusted release metadata. Missing files, absent publisher metadata, signature failures, and verification timeouts select Node instead. Development builds require no signing certificate.

Verification is cached for the host process lifetime. A verified helper remains locked against modification or replacement while that process runs; restart the host after installing or updating it. Verification uses Windows PowerShell. Windows may retrieve certificate trust information during verification; a bounded timeout falls back to Node.

A fast PE-header check rejects unsigned files before starting signature verification. It reads only the header fields locating the certificate table and its record header, never the executable payload. A certificate table only indicates that a signature may be present; Windows still validates the signed file and publisher before native execution. An empty publisher policy skips file inspection entirely.

To build the optional native helper or run its lifecycle tests, use Visual Studio C++ tools:

```sh
node experiments/ffi-pty/build-windows-helper.mts
```

The build writes `build/ffi-pty/win32-<arch>/helper.exe`; `--arch=x64` and `--arch=arm64` select a target explicitly. Spawning a terminal never compiles or downloads the helper. Normal terminal use does not require this file. Build it before running the full Windows test suite, which exercises the unsigned helper directly as an internal test fixture.

The signed-helper trust integration test runs only on disposable GitHub-hosted Windows runners; it adds a unique temporary certificate to the machine root store and removes it during cleanup.

CI artifacts are unsigned experimental builds. Public helper releases need a maintainer-owned Windows signing process; checksums and build provenance do not replace Authenticode or override application-control policy. See [Microsoft's signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).

<details>
<summary>Signing the optional helper for release</summary>

Use the maintainer's existing signing service or [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview). Azure manages the publisher identity and keys; SignTool or the Azure GitHub Action applies the signature. The helper is a standalone EXE, so MSIX packaging is unnecessary.

Build and test each architecture, sign with SHA-256 and a timestamp, verify with `signtool verify /pa /all /v /tw helper.exe`, then include those exact bytes in the npm package. Reject missing timestamps and failed verification. Azure's short-lived certificates make timestamping essential. Keep signing credentials in the release infrastructure; GitHub OIDC avoids a long-lived client secret. See [signing integration](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations) and [OIDC setup](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md).

The expected publisher is release metadata, not a user environment override. Do not pin a rotating leaf certificate thumbprint. Signing establishes publisher identity but does not bypass machine policy or guarantee immediate SmartScreen reputation.

</details>

The CI workflow tests macOS and Ubuntu on x64/ARM64, Windows Server 2022 and 2025 on x64, and Windows 11 on ARM64. Windows jobs also build the native helper and publish it as a downloadable artifact. Check workflow results for validation status.
