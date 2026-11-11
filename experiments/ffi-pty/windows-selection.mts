import { createRequire } from "node:module";
import type { WindowsTransport } from "./windows-transport.mts";
import {
  classifyWindowsVersion,
  detectWindowsVersion,
  type WindowsVersion,
} from "./windows-version.mts";
import { getVerifiedHelper, type HelperVerification } from "./windows-helper-trust.mts";

const require = createRequire(import.meta.url);

export interface WindowsSelectionDependencies {
  verifyHelper(): Promise<HelperVerification>;
  createNodeTransport(): WindowsTransport;
  createHelperTransport(path: string): WindowsTransport;
  createFfiTransport(): WindowsTransport;
}

export function defaultWindowsSelectionDependencies(): WindowsSelectionDependencies {
  return {
    verifyHelper: getVerifiedHelper,
    createNodeTransport() {
      return (
        require("./windows-broker-client.mts") as { createNodeTransport(): WindowsTransport }
      ).createNodeTransport();
    },
    createHelperTransport(path) {
      return (
        require("./windows-helper.mts") as { createHelperTransport(path: string): WindowsTransport }
      ).createHelperTransport(path);
    },
    createFfiTransport() {
      return (
        require("./windows-ffi.mts") as { createFfiTransport(): WindowsTransport }
      ).createFfiTransport();
    },
  };
}

export async function createWindowsTransport(
  version: WindowsVersion = detectWindowsVersion(),
  dependencies = defaultWindowsSelectionDependencies(),
): Promise<WindowsTransport> {
  const mode = classifyWindowsVersion(version);
  if (mode === "unsupported") {
    throw new Error(
      `Windows build ${version.major}.${version.minor}.${version.build} does not support ConPTY`,
    );
  }
  if (mode === "ffi") {
    return dependencies.createFfiTransport();
  }

  const verified = await dependencies.verifyHelper();
  if (verified.kind === "node") {
    return dependencies.createNodeTransport();
  }
  let transport: WindowsTransport | undefined;
  try {
    transport = dependencies.createHelperTransport(verified.path);
    await transport.ready;
    return transport;
  } catch {
    await transport?.terminate().catch(() => {});
    return dependencies.createNodeTransport();
  }
}
