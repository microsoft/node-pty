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

#include <winpty.h>
#include <windows.h>
#include <assert.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>
#include <string>
#include <vector>
#include <limits>
#include "../shared/DebugClient.h"
#include "../shared/AgentMsg.h"
#include "../shared/Buffer.h"
#include "../shared/GenRandom.h"
#include "../shared/OwnedHandle.h"
#include "../shared/StringBuilder.h"
#include "../shared/StringUtil.h"
#include "../shared/WindowsSecurity.h"
#include "../shared/WindowsVersion.h"
#include "../shared/WinptyException.h"
#include "../shared/WinptyVersion.h"

// TODO: Error handling, handle out-of-memory.

#define AGENT_EXE L"winpty-agent.exe"

struct winpty_s {
    winpty_s();
    HANDLE controlPipe;
    HANDLE dataPipe;
};

winpty_s::winpty_s() : controlPipe(NULL), dataPipe(NULL)
{
}

static HMODULE getCurrentModule()
{
    HMODULE module;
    if (!GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCWSTR>(getCurrentModule),
                &module)) {
        assert(false && "GetModuleHandleEx failed");
    }
    return module;
}

static std::wstring getModuleFileName(HMODULE module)
{
    const int bufsize = 4096;
    wchar_t path[bufsize];
    int size = GetModuleFileNameW(module, path, bufsize);
    assert(size != 0 && size != bufsize);
    return std::wstring(path);
}

static std::wstring dirname(const std::wstring &path)
{
    std::wstring::size_type pos = path.find_last_of(L"\\/");
    if (pos == std::wstring::npos)
        return L"";
    else
        return path.substr(0, pos);
}

static bool pathExists(const std::wstring &path)
{
    return GetFileAttributesW(path.c_str()) != 0xFFFFFFFF;
}

static std::wstring findAgentProgram()
{
    std::wstring progDir = dirname(getModuleFileName(getCurrentModule()));
    std::wstring ret = progDir + (L"\\" AGENT_EXE);
    assert(pathExists(ret));
    return ret;
}

// Call ConnectNamedPipe and block, even for an overlapped pipe.  If the
// pipe is overlapped, create a temporary event for use connecting.
static bool connectNamedPipe(HANDLE handle, bool overlapped)
{
    OVERLAPPED over, *pover = NULL;
    if (overlapped) {
        pover = &over;
        memset(&over, 0, sizeof(over));
        over.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        assert(over.hEvent != NULL);
    }
    bool success = ConnectNamedPipe(handle, pover);
    if (overlapped && !success && GetLastError() == ERROR_IO_PENDING) {
        DWORD actual;
        success = GetOverlappedResult(handle, pover, &actual, TRUE);
    }
    if (!success && GetLastError() == ERROR_PIPE_CONNECTED)
        success = TRUE;
    if (overlapped)
        CloseHandle(over.hEvent);
    return success;
}

static inline WriteBuffer newPacket()
{
    WriteBuffer packet;
    packet.putRawValue<uint64_t>(0); // Reserve space for size.
    return packet;
}

static void writePacket(winpty_t *pc, WriteBuffer &packet)
{
    packet.replaceRawValue<uint64_t>(0, packet.buf().size());
    const auto &buf = packet.buf();
    DWORD actual = 0;
    ASSERT(buf.size() <= std::numeric_limits<DWORD>::max());
    const BOOL success = WriteFile(pc->controlPipe, buf.data(), buf.size(),
        &actual, nullptr);
    ASSERT(success && actual == buf.size());
}

static int32_t readInt32(winpty_t *pc)
{
    int32_t result;
    DWORD actual;
    BOOL success = ReadFile(pc->controlPipe, &result, sizeof(int32_t), &actual, NULL);
    assert(success && actual == sizeof(int32_t));
    return result;
}

static HANDLE createNamedPipe(const std::wstring &name, bool overlapped)
{
    try {
        const auto sd = createPipeSecurityDescriptorOwnerFullControl();
        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.lpSecurityDescriptor = sd.get();
        return CreateNamedPipeW(name.c_str(),
                                /*dwOpenMode=*/
                                    PIPE_ACCESS_DUPLEX |
                                    FILE_FLAG_FIRST_PIPE_INSTANCE |
                                    (overlapped ? FILE_FLAG_OVERLAPPED : 0),
                                /*dwPipeMode=*/
                                    rejectRemoteClientsPipeFlag(),
                                /*nMaxInstances=*/1,
                                /*nOutBufferSize=*/0,
                                /*nInBufferSize=*/0,
                                /*nDefaultTimeOut=*/3000,
                                &sa);
    } catch (const WinptyException &e) {
        trace("createNamedPipe: exception thrown: %s",
            utf8FromWide(e.what()).c_str());
        return INVALID_HANDLE_VALUE;
    }
}

struct BackgroundDesktop {
    BackgroundDesktop();
    HWINSTA originalStation;
    HWINSTA station;
    HDESK desktop;
    std::wstring desktopName;
};

BackgroundDesktop::BackgroundDesktop() :
        originalStation(NULL), station(NULL), desktop(NULL)
{
}

static std::wstring getObjectName(HANDLE object)
{
    BOOL success;
    DWORD lengthNeeded = 0;
    GetUserObjectInformationW(object, UOI_NAME,
                              NULL, 0,
                              &lengthNeeded);
    assert(lengthNeeded % sizeof(wchar_t) == 0);
    wchar_t *tmp = new wchar_t[lengthNeeded / 2];
    success = GetUserObjectInformationW(object, UOI_NAME,
                                        tmp, lengthNeeded,
                                        NULL);
    assert(success && "GetUserObjectInformationW failed");
    std::wstring ret = tmp;
    delete [] tmp;
    return ret;
}

// For debugging purposes, provide a way to keep the console on the main window
// station, visible.
static bool shouldShowConsoleWindow()
{
    char buf[32];
    return GetEnvironmentVariableA("WINPTY_SHOW_CONSOLE", buf, sizeof(buf)) > 0;
}

static bool shouldCreateBackgroundDesktop() {
    // Prior to Windows 7, winpty's repeated selection-deselection loop
    // prevented the user from interacting with their *visible* console
    // windows, unless we placed the console onto a background desktop.
    // The SetProcessWindowStation call interferes with the clipboard and
    // isn't thread-safe, though[1].  The call should perhaps occur in a
    // special agent subprocess.  Spawning a process in a background desktop
    // also breaks ConEmu, but marking the process SW_HIDE seems to correct
    // that[2].
    //
    // Windows 7 moved a lot of console handling out of csrss.exe and into
    // a per-console conhost.exe process, which may explain why it isn't
    // affected.
    //
    // This is a somewhat risky change, so there are low-level flags to
    // assist in debugging if there are issues.
    //
    // [1] https://github.com/rprichard/winpty/issues/58
    // [2] https://github.com/rprichard/winpty/issues/70
    bool ret = !shouldShowConsoleWindow() && !isAtLeastWindows7();
    const bool force = hasDebugFlag("force_desktop");
    const bool suppress = hasDebugFlag("no_desktop");
    if (force && suppress) {
        trace("error: Both the force_desktop and no_desktop flags are set");
    } else if (force) {
        ret = true;
    } else if (suppress) {
        ret = false;
    }
    return ret;
}

// Get a non-interactive window station for the agent.
// TODO: review security w.r.t. windowstation and desktop.
static BackgroundDesktop setupBackgroundDesktop()
{
    BackgroundDesktop ret;
    if (shouldCreateBackgroundDesktop()) {
        const HWINSTA originalStation = GetProcessWindowStation();
        ret.station = CreateWindowStationW(NULL, 0, WINSTA_ALL_ACCESS, NULL);
        if (ret.station != NULL) {
            ret.originalStation = originalStation;
            bool success = SetProcessWindowStation(ret.station);
            assert(success && "SetProcessWindowStation failed");
            ret.desktop = CreateDesktopW(L"Default", NULL, NULL, 0, GENERIC_ALL, NULL);
            assert(ret.originalStation != NULL);
            assert(ret.station != NULL);
            assert(ret.desktop != NULL);
            ret.desktopName =
                getObjectName(ret.station) + L"\\" + getObjectName(ret.desktop);
            trace("Created background desktop: %s",
                utf8FromWide(ret.desktopName).c_str());
        } else {
            trace("CreateWindowStationW failed");
        }
    }
    return ret;
}

static void restoreOriginalDesktop(const BackgroundDesktop &desktop)
{
    if (desktop.station != NULL) {
        SetProcessWindowStation(desktop.originalStation);
        CloseDesktop(desktop.desktop);
        CloseWindowStation(desktop.station);
    }
}

static std::wstring getDesktopFullName()
{
    // MSDN says that the handle returned by GetThreadDesktop does not need
    // to be passed to CloseDesktop.
    HWINSTA station = GetProcessWindowStation();
    HDESK desktop = GetThreadDesktop(GetCurrentThreadId());
    assert(station != NULL && "GetProcessWindowStation returned NULL");
    assert(desktop != NULL && "GetThreadDesktop returned NULL");
    return getObjectName(station) + L"\\" + getObjectName(desktop);
}

static bool shouldSpecifyHideFlag() {
    const bool force = hasDebugFlag("force_sw_hide");
    const bool suppress = hasDebugFlag("no_sw_hide");
    bool ret = !shouldShowConsoleWindow();
    if (force && suppress) {
        trace("error: Both the force_sw_hide and no_sw_hide flags are set");
    } else if (force) {
        ret = true;
    } else if (suppress) {
        ret = false;
    }
    return ret;
}

static void startAgentProcess(const BackgroundDesktop &desktop,
                              const std::wstring &controlPipeName,
                              const std::wstring &dataPipeName,
                              int cols, int rows,
                              HANDLE &agentProcess,
                              DWORD &agentPid)
{
    const std::wstring exePath = findAgentProgram();
    const std::wstring cmdline =
        (WStringBuilder(256)
            << L"\"" << exePath << L"\" "
            << controlPipeName << L' ' << dataPipeName << L' '
            << cols << L' ' << rows).str_moved();

    auto cmdlineV = vectorWithNulFromString(cmdline);
    auto desktopV = vectorWithNulFromString(desktop.desktopName);

    // Start the agent.
    STARTUPINFOW sui = {};
    sui.cb = sizeof(sui);
    sui.lpDesktop = desktop.station == NULL ? NULL : desktopV.data();
    if (shouldSpecifyHideFlag()) {
        sui.dwFlags |= STARTF_USESHOWWINDOW;
        sui.wShowWindow = SW_HIDE;
    }
    PROCESS_INFORMATION pi = {};
    const BOOL success =
        CreateProcessW(exePath.c_str(),
                       cmdlineV.data(),
                       NULL, NULL,
                       /*bInheritHandles=*/FALSE,
                       /*dwCreationFlags=*/CREATE_NEW_CONSOLE,
                       NULL, NULL,
                       &sui, &pi);
    if (success) {
        trace("Created agent successfully, pid=%u, cmdline=%s",
              static_cast<unsigned int>(pi.dwProcessId),
              utf8FromWide(cmdline).c_str());
    } else {
        unsigned int err = GetLastError();
        trace("Error creating agent, err=%#x, cmdline=%s",
              err, utf8FromWide(cmdline).c_str());
        fprintf(stderr, "Error %#x starting %s\n", err,
            utf8FromWide(cmdline).c_str());
        exit(1);
    }

    CloseHandle(pi.hThread);

    agentProcess = pi.hProcess;
    agentPid = pi.dwProcessId;
}

static bool verifyPipeClientPid(HANDLE serverPipe, DWORD agentPid)
{
    const auto client = getNamedPipeClientProcessId(serverPipe);
    const auto err = GetLastError();
    const auto success = std::get<0>(client);
    if (success == GetNamedPipeClientProcessId_Result::Success) {
        const auto clientPid = std::get<1>(client);
        if (clientPid != agentPid) {
            trace("Security check failed: pipe client pid (%u) does not "
                "match agent pid (%u)",
                static_cast<unsigned int>(clientPid),
                static_cast<unsigned int>(agentPid));
            return false;
        }
        return true;
    } else if (success == GetNamedPipeClientProcessId_Result::UnsupportedOs) {
        trace("Pipe client PID security check skipped: "
            "GetNamedPipeClientProcessId unsupported on this OS version");
        return true;
    } else {
        trace("GetNamedPipeClientProcessId failed: %u",
            static_cast<unsigned int>(err));
        return false;
    }
}

WINPTY_API winpty_t *winpty_open(int cols, int rows)
{
    dumpWindowsVersion();
    dumpVersionToTrace();

    winpty_t *pc = new winpty_t;

    // Start pipes.
    const auto basePipeName =
        L"\\\\.\\pipe\\winpty-" + GenRandom().uniqueName();
    const std::wstring controlPipeName = basePipeName + L"-control";
    const std::wstring dataPipeName = basePipeName + L"-data";
    pc->controlPipe = createNamedPipe(controlPipeName, false);
    if (pc->controlPipe == INVALID_HANDLE_VALUE) {
        delete pc;
        return NULL;
    }
    pc->dataPipe = createNamedPipe(dataPipeName, true);
    if (pc->dataPipe == INVALID_HANDLE_VALUE) {
        delete pc;
        return NULL;
    }

    // Setup a background desktop for the agent.
    BackgroundDesktop desktop = setupBackgroundDesktop();

    // Start the agent.
    HANDLE agentProcess = NULL;
    DWORD agentPid = INFINITE;
    startAgentProcess(desktop, controlPipeName, dataPipeName, cols, rows,
                      agentProcess, agentPid);
    OwnedHandle autoClose(agentProcess);

    // TODO: Frequently, I see the CreateProcess call return successfully,
    // but the agent immediately dies.  The following pipe connect calls then
    // hang.  These calls should probably timeout.  Maybe this code could also
    // poll the agent process handle?

    // Connect the pipes.
    bool success;
    success = connectNamedPipe(pc->controlPipe, false);
    if (!success) {
        delete pc;
        return NULL;
    }
    success = connectNamedPipe(pc->dataPipe, true);
    if (!success) {
        delete pc;
        return NULL;
    }

    // Close handles to the background desktop and restore the original window
    // station.  This must wait until we know the agent is running -- if we
    // close these handles too soon, then the desktop and windowstation will be
    // destroyed before the agent can connect with them.
    restoreOriginalDesktop(desktop);

    // Check that the pipe clients are correct.
    if (!verifyPipeClientPid(pc->controlPipe, agentPid) ||
            !verifyPipeClientPid(pc->dataPipe, agentPid)) {
        delete pc;
        return NULL;
    }

    // TODO: This comment is now out-of-date.  The named pipes now have a DACL
    // that should prevent arbitrary users from connecting, even just to read.
    //
    // The default security descriptor for a named pipe allows anyone to connect
    // to the pipe to read, but not to write.  Only the "creator owner" and
    // various system accounts can write to the pipe.  By sending and receiving
    // a dummy message on the control pipe, we should confirm that something
    // trusted (i.e. the agent we just started) successfully connected and wrote
    // to one of our pipes.
    auto packet = newPacket();
    packet.putInt32(AgentMsg::Ping);
    writePacket(pc, packet);
    if (readInt32(pc) != 0) {
        delete pc;
        return NULL;
    }

    return pc;
}

// Tyriar/pty.js start
WINPTY_API winpty_t *winpty_open_use_own_datapipe(const wchar_t *dataPipe, int cols, int rows)
{
    dumpWindowsVersion();
    dumpVersionToTrace();

    winpty_t *pc = new winpty_t;

    // Start pipes.
    const auto basePipeName =
        L"\\\\.\\pipe\\winpty-" + GenRandom().uniqueName();
    const std::wstring controlPipeName = basePipeName + L"-control";
    pc->controlPipe = createNamedPipe(controlPipeName, false);
    if (pc->controlPipe == INVALID_HANDLE_VALUE) {
        delete pc;
        return NULL;
    }
    // The callee provides his own pipe implementation for handling sending/recieving
	// data between the started child process.
	const std::wstring dataPipeName(dataPipe);

    // Setup a background desktop for the agent.
    BackgroundDesktop desktop = setupBackgroundDesktop();

    // Start the agent.
    HANDLE agentProcess = NULL;
    DWORD agentPid = INFINITE;
    startAgentProcess(desktop, controlPipeName, dataPipeName, cols, rows,
                      agentProcess, agentPid);
    OwnedHandle autoClose(agentProcess);

    // TODO: Frequently, I see the CreateProcess call return successfully,
    // but the agent immediately dies.  The following pipe connect calls then
    // hang.  These calls should probably timeout.  Maybe this code could also
    // poll the agent process handle?

    // Connect the pipes.
    bool success;
    success = connectNamedPipe(pc->controlPipe, false);
    if (!success) {
        delete pc;
        return NULL;
    }

    // Close handles to the background desktop and restore the original window
    // station.  This must wait until we know the agent is running -- if we
    // close these handles too soon, then the desktop and windowstation will be
    // destroyed before the agent can connect with them.
    restoreOriginalDesktop(desktop);

    // TODO: This comment is now out-of-date.  The named pipes now have a DACL
    // that should prevent arbitrary users from connecting, even just to read.
    //
    // The default security descriptor for a named pipe allows anyone to connect
    // to the pipe to read, but not to write.  Only the "creator owner" and
    // various system accounts can write to the pipe.  By sending and receiving
    // a dummy message on the control pipe, we should confirm that something
    // trusted (i.e. the agent we just started) successfully connected and wrote
    // to one of our pipes.
    auto packet = newPacket();
    packet.putInt32(AgentMsg::Ping);
    writePacket(pc, packet);
    if (readInt32(pc) != 0) {
        delete pc;
        return NULL;
    }

    return pc;
}
// Tyriar/pty.js finish

// Return a std::wstring containing every character of the environment block.
// Typically, the block is non-empty, so the std::wstring returned ends with
// two NUL terminators.  (These two terminators are counted in size(), so
// calling c_str() produces a triply-terminated string.)
static std::wstring wstringFromEnvBlock(const wchar_t *env)
{
    std::wstring envStr;
    if (env != NULL) {
        const wchar_t *p = env;
        while (*p != L'\0') {
            p += wcslen(p) + 1;
        }
        p++;
        envStr.assign(env, p);

        // Assuming the environment was non-empty, envStr now ends with two NUL
        // terminators.
        //
        // If the environment were empty, though, then envStr would only be
        // singly terminated, but the MSDN documentation thinks an env block is
        // always doubly-terminated, so add an extra NUL just in case it
        // matters.
        const auto envStrSz = envStr.size();
        if (envStrSz == 1) {
            ASSERT(envStr[0] == L'\0');
            envStr.push_back(L'\0');
        } else {
            ASSERT(envStrSz >= 3);
            ASSERT(envStr[envStrSz - 3] != L'\0');
            ASSERT(envStr[envStrSz - 2] == L'\0');
            ASSERT(envStr[envStrSz - 1] == L'\0');
        }
    }
    return envStr;
}

WINPTY_API int winpty_start_process(winpty_t *pc,
                                    const wchar_t *appname,
                                    const wchar_t *cmdline,
                                    const wchar_t *cwd,
                                    const wchar_t *env)
{
    auto packet = newPacket();
    packet.putInt32(AgentMsg::StartProcess);
    packet.putWString(appname ? appname : L"");
    packet.putWString(cmdline ? cmdline : L"");
    packet.putWString(cwd ? cwd : L"");
    packet.putWString(wstringFromEnvBlock(env));
    packet.putWString(getDesktopFullName());
    writePacket(pc, packet);
    return readInt32(pc);
}

WINPTY_API int winpty_get_exit_code(winpty_t *pc)
{
    auto packet = newPacket();
    packet.putInt32(AgentMsg::GetExitCode);
    writePacket(pc, packet);
    return readInt32(pc);
}

WINPTY_API int winpty_get_process_id(winpty_t *pc)
{
    auto packet = newPacket();
    packet.putInt32(AgentMsg::GetProcessId);
    writePacket(pc, packet);
    return readInt32(pc);
}

WINPTY_API HANDLE winpty_get_data_pipe(winpty_t *pc)
{
    return pc->dataPipe;
}

WINPTY_API int winpty_set_size(winpty_t *pc, int cols, int rows)
{
    auto packet = newPacket();
    packet.putInt32(AgentMsg::SetSize);
    packet.putInt32(cols);
    packet.putInt32(rows);
    writePacket(pc, packet);
    return readInt32(pc);
}

WINPTY_API void winpty_close(winpty_t *pc)
{
    CloseHandle(pc->controlPipe);
    CloseHandle(pc->dataPipe);
    delete pc;
}

WINPTY_API int winpty_set_console_mode(winpty_t *pc, int mode)
{
    auto packet = newPacket();
    packet.putInt32(AgentMsg::SetConsoleMode);
    packet.putInt32(mode);
    writePacket(pc, packet);
    return readInt32(pc);
}
