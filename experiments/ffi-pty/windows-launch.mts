import { randomUUID } from "node:crypto";
import type { SpawnOptions } from "./contract.mts";
import { validateDimension } from "./validation.mts";
import {
  buildWindowsCommandLine,
  buildWindowsEnvironmentBlock,
  resolveWindowsExecutable,
  windowsPipeNames,
} from "./windows-commandline.mts";

export interface WindowsStart {
  cols: number;
  rows: number;
  application: Buffer;
  commandLine: Buffer;
  cwd: Buffer;
  environment: Buffer;
  inputName: string;
  outputName: string;
}

export function encodeWindowsString(value: string): Buffer {
  if (value.includes("\0")) throw new TypeError("NUL in Windows string");
  return Buffer.from(`${value}\0`, "utf16le");
}

export function prepareWindowsStart(options: SpawnOptions): WindowsStart {
  validateDimension(options.cols, "cols");
  validateDimension(options.rows, "rows");
  const application = resolveWindowsExecutable(options.file, options.env, options.cwd);
  const pipes = windowsPipeNames(randomUUID());
  return {
    cols: options.cols,
    rows: options.rows,
    application: encodeWindowsString(application),
    commandLine: encodeWindowsString(buildWindowsCommandLine(options.file, options.args)),
    cwd: encodeWindowsString(options.cwd),
    environment: buildWindowsEnvironmentBlock(options.env),
    inputName: pipes.input,
    outputName: pipes.output,
  };
}
