/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */

declare module 'node-pty' {
  /**
   * Forks a process as a pseudoterminal.
   * @param file The file to launch.
   * @param args The file's arguments as argv (string[]) or in a pre-escaped CommandLine format
   * (string). Note that the CommandLine option is only available on Windows and is expected to be
   * escaped properly.
   * @param options The options of the terminal.
   * @see CommandLineToArgvW https://msdn.microsoft.com/en-us/library/windows/desktop/bb776391(v=vs.85).aspx
   * @see Parsing C++ Comamnd-Line Arguments https://msdn.microsoft.com/en-us/library/17w5ykft.aspx
   * @see GetCommandLine https://msdn.microsoft.com/en-us/library/windows/desktop/ms683156.aspx
   */
  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions | IWindowsPtyForkOptions): IPty;

  export interface IBasePtyForkOptions {

    /**
     * Name of the terminal to be set in environment ($TERM variable).
     */
    name?: string;

    /**
     * Number of intial cols of the pty.
     */
    cols?: number;

    /**
     * Number of initial rows of the pty.
     */
    rows?: number;

    /**
     * Working directory to be set for the child program.
     */
    cwd?: string;

    /**
     * Environment to be set for the child program.
     */
    env?: { [key: string]: string | undefined };

    /**
     * String encoding of the underlying pty.
     * If set, incoming data will be decoded to strings and outgoing strings to bytes applying this encoding.
     * If unset, incoming data will be delivered as raw bytes (Buffer type).
     * By default 'utf8' is assumed, to unset it explicitly set it to `null`.
     */
    encoding?: string | null;

    /**
     * (EXPERIMENTAL)
     * Whether to enable flow control handling (false by default). If enabled a message of `flowControlPause`
     * will pause the socket and thus blocking the child program execution due to buffer back pressure.
     * A message of `flowControlResume` will resume the socket into flow mode.
     * For performance reasons only a single message as a whole will match (no message part matching).
     * If flow control is enabled the `flowControlPause` and `flowControlResume` messages are not forwarded to
     * the underlying pseudoterminal.
     */
    handleFlowControl?: boolean;

    /**
     * (EXPERIMENTAL)
     * The string that should pause the pty when `handleFlowControl` is true. Default is XOFF ('\x13').
     */
    flowControlPause?: string;

    /**
     * (EXPERIMENTAL)
     * The string that should resume the pty when `handleFlowControl` is true. Default is XON ('\x11').
     */
    flowControlResume?: string;
  }

  export interface IPtyForkOptions extends IBasePtyForkOptions {
    /**
     * Security warning: use this option with great caution, as opened file descriptors
     * with higher privileges might leak to the child program.
     */
    uid?: number;
    gid?: number;
  }

  export interface IWindowsPtyForkOptions extends IBasePtyForkOptions {
    /**
     * Whether to use the ConPTY system on Windows. When this is not set, ConPTY will be used when
     * the Windows build number is >= 18309 (instead of winpty). Note that ConPTY is available from
     * build 17134 but is too unstable to enable by default.
     *
     * This setting does nothing on non-Windows.
     */
    useConpty?: boolean;

    /**
     * Whether to use PSEUDOCONSOLE_INHERIT_CURSOR in conpty.
     * @see https://docs.microsoft.com/en-us/windows/console/createpseudoconsole
     */
    conptyInheritCursor?: boolean;
  }

  /**
   * An interface representing a pseudoterminal, on Windows this is emulated via the winpty library.
   */
  export interface IPty {
    /**
     * The process ID of the outer process.
     */
    readonly pid: number;

    /**
     * The column size in characters.
     */
    readonly cols: number;

    /**
     * The row size in characters.
     */
    readonly rows: number;

    /**
     * The title of the active process.
     */
    readonly process: string;

    /**
     * (EXPERIMENTAL)
     * Whether to handle flow control. Useful to disable/re-enable flow control during runtime.
     * Use this for binary data that is likely to contain the `flowControlPause` string by accident.
     */
    handleFlowControl: boolean;

    /**
     * Adds an event listener for when a data event fires. This happens when data is returned from
     * the pty.
     * @returns an `IDisposable` to stop listening.
     */
    readonly onData: IEvent<string>;

    /**
     * Adds an event listener for when an exit event fires. This happens when the pty exits.
     * @returns an `IDisposable` to stop listening.
     */
    readonly onExit: IEvent<{ exitCode: number, signal?: number }>;

    /**
     * Adds a listener to the data event, fired when data is returned from the pty.
     * @param event The name of the event.
     * @param listener The callback function.
     * @deprecated Use IPty.onData
     */
    on(event: 'data', listener: (data: string) => void): void;

    /**
     * Adds a listener to the exit event, fired when the pty exits.
     * @param event The name of the event.
     * @param listener The callback function, exitCode is the exit code of the process and signal is
     * the signal that triggered the exit. signal is not supported on Windows.
     * @deprecated Use IPty.onExit
     */
    on(event: 'exit', listener: (exitCode: number, signal?: number) => void): void;

    /**
     * Resizes the dimensions of the pty.
     * @param columns THe number of columns to use.
     * @param rows The number of rows to use.
     */
    resize(columns: number, rows: number): void;

    /**
     * Writes data to the pty.
     * @param data The data to write.
     */
    write(data: string): void;

    /**
     * Kills the pty.
     * @param signal The signal to use, defaults to SIGHUP. This parameter is not supported on
     * Windows.
     * @throws Will throw when signal is used on Windows.
     */
    kill(signal?: string): void;

    /**
     * Pauses the pty for customizable flow control.
     */
    pause(): void;

    /**
     * Resumes the pty for customizable flow control.
     */
    resume(): void;
  }

  /**
   * An object that can be disposed via a dispose function.
   */
  export interface IDisposable {
    dispose(): void;
  }

  /**
   * An event that can be listened to.
   * @returns an `IDisposable` to stop listening.
   */
  export interface IEvent<T> {
    (listener: (e: T) => any): IDisposable;
  }
}
