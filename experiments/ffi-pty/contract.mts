import type { Readable } from "node:stream";

export interface ExitStatus {
  exitCode: number | null;
  signal: number;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface SpawnOptionsInput {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  encoding?: "utf8";
  uid?: never;
  gid?: never;
  pixelWidth?: never;
  pixelHeight?: never;
  useConptyDll?: never;
  conptyInheritCursor?: never;
  [key: string]: unknown;
}

export interface Backend {
  pid: number;
  readable: Readable;
  write(data: Buffer): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(signal?: string): Promise<void>;
  close(): Promise<void>;
  exited: Promise<ExitStatus>;
}

export interface FfiPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly exited: Promise<ExitStatus>;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (status: ExitStatus) => void): { dispose(): void };
  write(data: string | Buffer): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(signal?: string): Promise<void>;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}
