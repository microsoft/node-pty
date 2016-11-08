// Copyright (c) 2011-2015 Ryan Prichard
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

// MSYS's sys/cygwin.h header only declares cygwin_internal if WINVER is
// defined, which is defined in windows.h.  Therefore, include windows.h early.
#include <windows.h>

#include <assert.h>
#include <cygwin/version.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/cygwin.h>
#include <termios.h>
#include <unistd.h>

#include <map>
#include <string>
#include <vector>

#include <winpty.h>
#include "../shared/DebugClient.h"
#include "../shared/UnixCtrlChars.h"
#include "../shared/WinptyVersion.h"
#include "InputHandler.h"
#include "OutputHandler.h"
#include "Util.h"
#include "WakeupFd.h"

#define CSI "\x1b["

static WakeupFd *g_mainWakeup = NULL;

static WakeupFd &mainWakeup()
{
    if (g_mainWakeup == NULL) {
        static const char msg[] = "Internal error: g_mainWakeup is NULL\r\n";
        write(STDERR_FILENO, msg, sizeof(msg) - 1);
        abort();
    }
    return *g_mainWakeup;
}

// Put the input terminal into non-canonical mode.
static termios setRawTerminalMode()
{
    if (!isatty(STDIN_FILENO)) {
        fprintf(stderr, "input is not a tty\n");
        exit(1);
    }
    if (!isatty(STDOUT_FILENO)) {
        fprintf(stderr, "output is not a tty\n");
        exit(1);
    }

    termios buf;
    if (tcgetattr(STDIN_FILENO, &buf) < 0) {
        perror("tcgetattr failed");
        exit(1);
    }
    termios saved = buf;
    buf.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    buf.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    buf.c_cflag &= ~(CSIZE | PARENB);
    buf.c_cflag |= CS8;
    buf.c_oflag &= ~OPOST;
    buf.c_cc[VMIN] = 1;  // blocking read
    buf.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &buf) < 0) {
        fprintf(stderr, "tcsetattr failed\n");
        exit(1);
    }
    return saved;
}

static void restoreTerminalMode(termios original)
{
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &original) < 0) {
        perror("error restoring terminal mode");
        exit(1);
    }
}

static void debugShowKey()
{
    printf("\r\nPress any keys -- Ctrl-D exits\r\n\r\n");
    const termios saved = setRawTerminalMode();
    char buf[128];
    while (true) {
        const ssize_t len = read(STDIN_FILENO, buf, sizeof(buf));
        if (len <= 0) {
            break;
        }
        for (int i = 0; i < len; ++i) {
            char ctrl = decodeUnixCtrlChar(buf[i]);
            if (ctrl == '\0') {
                putchar(buf[i]);
            } else {
                putchar('^');
                putchar(ctrl);
            }
        }
        for (int i = 0; i < len; ++i) {
            unsigned char uch = buf[i];
            printf("\t%3d %04o 0x%02x\r\n", uch, uch, uch);
        }
        if (buf[0] == 4) {
            // Ctrl-D
            break;
        }
    }
    restoreTerminalMode(saved);
}

static void terminalResized(int signo)
{
    mainWakeup().set();
}

static void registerResizeSignalHandler()
{
    struct sigaction resizeSigAct;
    memset(&resizeSigAct, 0, sizeof(resizeSigAct));
    resizeSigAct.sa_handler = terminalResized;
    resizeSigAct.sa_flags = SA_RESTART;
    sigaction(SIGWINCH, &resizeSigAct, NULL);
}

// Convert the path to a Win32 path if it is a POSIX path, and convert slashes
// to backslashes.
static std::string convertPosixPathToWin(const std::string &path)
{
    char *tmp;
#if defined(CYGWIN_VERSION_CYGWIN_CONV) && \
        CYGWIN_VERSION_API_MINOR >= CYGWIN_VERSION_CYGWIN_CONV
    // MSYS2 and versions of Cygwin released after 2009 or so use this API.
    // The original MSYS still lacks this API.
    ssize_t newSize = cygwin_conv_path(CCP_POSIX_TO_WIN_A | CCP_RELATIVE,
                                       path.c_str(), NULL, 0);
    assert(newSize >= 0);
    tmp = new char[newSize + 1];
    ssize_t success = cygwin_conv_path(CCP_POSIX_TO_WIN_A | CCP_RELATIVE,
                                       path.c_str(), tmp, newSize + 1);
    assert(success == 0);
#else
    // In the current Cygwin header file, this API is documented as deprecated
    // because it's restricted to paths of MAX_PATH length.  In the CVS version
    // of MSYS, the newer API doesn't exist, and this older API is implemented
    // using msys_p2w, which seems like it would handle paths larger than
    // MAX_PATH, but there's no way to query how large the new path is.
    // Hopefully, this is large enough.
    tmp = new char[MAX_PATH + path.size()];
    cygwin_conv_to_win32_path(path.c_str(), tmp);
#endif
    for (int i = 0; tmp[i] != '\0'; ++i) {
        if (tmp[i] == '/')
            tmp[i] = '\\';
    }
    std::string ret(tmp);
    delete [] tmp;
    return ret;
}

// Convert argc/argv into a Win32 command-line following the escaping convention
// documented on MSDN.  (e.g. see CommandLineToArgvW documentation)
static std::string argvToCommandLine(const std::vector<std::string> &argv)
{
    std::string result;
    for (size_t argIndex = 0; argIndex < argv.size(); ++argIndex) {
        if (argIndex > 0)
            result.push_back(' ');
        const char *arg = argv[argIndex].c_str();
        const bool quote =
            strchr(arg, ' ') != NULL ||
            strchr(arg, '\t') != NULL ||
            *arg == '\0';
        if (quote)
            result.push_back('\"');
        int bsCount = 0;
        for (const char *p = arg; *p != '\0'; ++p) {
            if (*p == '\\') {
                bsCount++;
            } else if (*p == '\"') {
                result.append(bsCount * 2 + 1, '\\');
                result.push_back('\"');
                bsCount = 0;
            } else {
                result.append(bsCount, '\\');
                bsCount = 0;
                result.push_back(*p);
            }
        }
        if (quote) {
            result.append(bsCount * 2, '\\');
            result.push_back('\"');
        } else {
            result.append(bsCount, '\\');
        }
    }
    return result;
}

static wchar_t *heapMbsToWcs(const char *text)
{
    // Calling mbstowcs with a NULL first argument seems to be broken on MSYS.
    // Instead of returning the size of the converted string, it returns 0.
    // Using strlen(text) * 2 is probably big enough.
    size_t maxLen = strlen(text) * 2 + 1;
    wchar_t *ret = new wchar_t[maxLen];
    size_t len = mbstowcs(ret, text, maxLen);
    assert(len != (size_t)-1 && len < maxLen);
    return ret;
}

static char *heapWcsToMbs(const wchar_t *text)
{
    // Calling wcstombs with a NULL first argument seems to be broken on MSYS.
    // Instead of returning the size of the converted string, it returns 0.
    // Using wcslen(text) * 3 is big enough for UTF-8 and probably other
    // encodings.  For UTF-8, codepoints that fit in a single wchar
    // (U+0000 to U+FFFF) are encoded using 1-3 bytes.  The remaining code
    // points needs two wchar's and are encoded using 4 bytes.
    size_t maxLen = wcslen(text) * 3 + 1;
    char *ret = new char[maxLen];
    size_t len = wcstombs(ret, text, maxLen);
    if (len == (size_t)-1 || len >= maxLen) {
        delete [] ret;
        return NULL;
    } else {
        return ret;
    }
}

void setupWin32Environment()
{
    std::map<std::string, std::string> varsToCopy;
    const char *vars[] = {
        "WINPTY_DEBUG",
        "WINPTY_SHOW_CONSOLE",
        NULL
    };
    for (int i = 0; vars[i] != NULL; ++i) {
        const char *cstr = getenv(vars[i]);
        if (cstr != NULL && cstr[0] != '\0') {
            varsToCopy[vars[i]] = cstr;
        }
    }

#if defined(__MSYS__) && CYGWIN_VERSION_API_MINOR >= 48 || \
        !defined(__MSYS__) && CYGWIN_VERSION_API_MINOR >= 153
    // Use CW_SYNC_WINENV to copy the Unix environment to the Win32
    // environment.  The command performs special translation on some variables
    // (such as PATH and TMP).  It also copies the debugging environment
    // variables.
    //
    // Note that the API minor versions have diverged in Cygwin and MSYS.
    // CW_SYNC_WINENV was added to Cygwin in version 153.  (Cygwin's
    // include/cygwin/version.h says that CW_SETUP_WINENV was added in 153.
    // The flag was renamed 8 days after it was added, but the API docs weren't
    // updated.)  The flag was added to MSYS in version 48.
    //
    // Also, in my limited testing, this call seems to be necessary with Cygwin
    // but unnecessary with MSYS.  Perhaps MSYS is automatically syncing the
    // Unix environment with the Win32 environment before starting console.exe?
    // It shouldn't hurt to call it for MSYS.
    cygwin_internal(CW_SYNC_WINENV);
#endif

    // Copy debugging environment variables from the Cygwin environment
    // to the Win32 environment so the agent will inherit it.
    for (std::map<std::string, std::string>::iterator it = varsToCopy.begin();
            it != varsToCopy.end();
            ++it) {
        wchar_t *nameW = heapMbsToWcs(it->first.c_str());
        wchar_t *valueW = heapMbsToWcs(it->second.c_str());
        SetEnvironmentVariableW(nameW, valueW);
        delete [] nameW;
        delete [] valueW;
    }

    // Clear the TERM variable.  The child process's immediate console/terminal
    // environment is a Windows console, not the terminal that winpty is
    // communicating with.  Leaving the TERM variable set can break programs in
    // various ways.  (e.g. arrows keys broken in Cygwin less, IronPython's
    // help(...) function doesn't start, misc programs decide they should
    // output color escape codes on pre-Win10).  See
    // https://github.com/rprichard/winpty/issues/43.
    SetEnvironmentVariableW(L"TERM", NULL);
}

static void usage(const char *program, int exitCode)
{
    printf("Usage: %s [options] [--] program [args]\n", program);
    printf("\n");
    printf("Options:\n");
    printf("  -h, --help  Show this help message\n");
    printf("  --mouse     Enable terminal mouse input\n");
    printf("  --showkey   Dump STDIN escape sequences\n");
    printf("  --version   Show the winpty version number\n");
    exit(exitCode);
}

struct Arguments {
    std::vector<std::string> childArgv;
    bool mouseInput;
};

static void parseArguments(int argc, char *argv[], Arguments &out)
{
    out.mouseInput = false;
    const char *const program = argc >= 1 ? argv[0] : "<program>";
    int argi = 1;
    while (argi < argc) {
        std::string arg(argv[argi++]);
        if (arg.size() >= 1 && arg[0] == '-') {
            if (arg == "-h" || arg == "--help") {
                usage(program, 0);
            } else if (arg == "--mouse") {
                out.mouseInput = true;
            } else if (arg == "--showkey") {
                debugShowKey();
                exit(0);
            } else if (arg == "--version") {
                dumpVersionToStdout();
                exit(0);
            } else if (arg == "--") {
                break;
            } else {
                fprintf(stderr, "Error: unrecognized option: '%s'\n",
                    arg.c_str());
                exit(1);
            }
        } else {
            out.childArgv.push_back(arg);
            break;
        }
    }
    for (; argi < argc; ++argi) {
        out.childArgv.push_back(argv[argi]);
    }
    if (out.childArgv.size() == 0) {
        usage(program, 1);
    }
}

static std::string formatErrorMessage(DWORD err)
{
    // Use FormatMessageW rather than FormatMessageA, because we want to use
    // wcstombs to convert to the Cygwin locale, which might not match the
    // codepage FormatMessageA would use.  We need to convert using wcstombs,
    // rather than print using %ls, because %ls doesn't work in the original
    // MSYS.
    wchar_t *wideMsgPtr = NULL;
    const DWORD formatRet = FormatMessageW(
        FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_ALLOCATE_BUFFER |
            FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL,
        err,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&wideMsgPtr),
        0,
        NULL);
    if (formatRet == 0 || wideMsgPtr == NULL) {
        return std::string();
    }
    char *const msgPtr = heapWcsToMbs(wideMsgPtr);
    LocalFree(wideMsgPtr);
    if (msgPtr == NULL) {
        return std::string();
    }
    std::string msg = msgPtr;
    delete [] msgPtr;
    const size_t pos = msg.find_last_not_of(" \r\n\t");
    if (pos == std::string::npos) {
        msg.clear();
    } else {
        msg.erase(pos + 1);
    }
    return msg;
}

int main(int argc, char *argv[])
{
    setlocale(LC_ALL, "");

    g_mainWakeup = new WakeupFd();

    Arguments args;
    parseArguments(argc, argv, args);

    setupWin32Environment();

    winsize sz;
    ioctl(STDIN_FILENO, TIOCGWINSZ, &sz);

    winpty_t *winpty = winpty_open(sz.ws_col, sz.ws_row);
    if (winpty == NULL) {
        fprintf(stderr, "Error creating winpty.\n");
        exit(1);
    }

    {
        // Start the child process under the console.
        args.childArgv[0] = convertPosixPathToWin(args.childArgv[0]);
        std::string cmdLine = argvToCommandLine(args.childArgv);
        wchar_t *cmdLineW = heapMbsToWcs(cmdLine.c_str());
        const int ret = winpty_start_process(winpty,
                                             NULL,
                                             cmdLineW,
                                             NULL,
                                             NULL);
        if (ret != 0) {
            const std::string errorMsg = formatErrorMessage(ret);
            if (!errorMsg.empty()) {
                fprintf(stderr, "Could not start '%s': %s (error %#x)\n",
                    cmdLine.c_str(),
                    errorMsg.c_str(),
                    static_cast<unsigned int>(ret));
            } else {
                fprintf(stderr, "Could not start '%s': error %#x\n",
                    cmdLine.c_str(),
                    static_cast<unsigned int>(ret));
            }
            exit(1);
        }
        delete [] cmdLineW;
    }

    registerResizeSignalHandler();
    termios mode = setRawTerminalMode();

    if (args.mouseInput) {
        // Start by disabling UTF-8 coordinate mode (1005), just in case we
        // have a terminal that does not support 1006/1015 modes, and 1005
        // happens to be enabled.  The UTF-8 coordinates can't be unambiguously
        // decoded.
        //
        // Enable basic mouse support first (1000), then try to switch to
        // button-move mode (1002), then try full mouse-move mode (1003).
        // Terminals that don't support a mode will be stuck at the highest
        // mode they do support.
        //
        // Enable encoding mode 1015 first, then try to switch to 1006.  On
        // some terminals, both modes will be enabled, but 1006 will have
        // priority.  On other terminals, 1006 wins because it's listed last.
        //
        // See misc/MouseInputNotes.txt for details.
        writeStr(STDOUT_FILENO,
            CSI"?1005l"
            CSI"?1000h" CSI"?1002h" CSI"?1003h" CSI"?1015h" CSI"?1006h");
    }

    OutputHandler outputHandler(winpty_get_data_pipe(winpty), mainWakeup());
    InputHandler inputHandler(winpty_get_data_pipe(winpty), mainWakeup());

    while (true) {
        fd_set readfds;
        FD_ZERO(&readfds);
        FD_SET(mainWakeup().fd(), &readfds);
        selectWrapper("main thread", mainWakeup().fd() + 1, &readfds);
        mainWakeup().reset();

        // Check for terminal resize.
        {
            winsize sz2;
            ioctl(STDIN_FILENO, TIOCGWINSZ, &sz2);
            if (memcmp(&sz, &sz2, sizeof(sz)) != 0) {
                sz = sz2;
                winpty_set_size(winpty, sz.ws_col, sz.ws_row);
            }
        }

        // Check for an I/O handler shutting down (possibly indicating that the
        // child process has exited).
        if (outputHandler.isComplete() || inputHandler.isComplete()) {
            break;
        }
    }

    outputHandler.shutdown();
    inputHandler.shutdown();

    const int exitCode = winpty_get_exit_code(winpty);

    if (args.mouseInput) {
        // Reseting both encoding modes (1006 and 1015) is necessary, but
        // apparently we only need to use reset on one of the 100[023] modes.
        // Doing both doesn't hurt.
        writeStr(STDOUT_FILENO,
            CSI"?1006l" CSI"?1015l" CSI"?1003l" CSI"?1002l" CSI"?1000l");
    }

    restoreTerminalMode(mode);
    winpty_close(winpty);

    return exitCode;
}
