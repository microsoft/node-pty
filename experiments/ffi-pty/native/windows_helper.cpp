#include <windows.h>
#include <consoleapi3.h>
#include <processthreadsapi.h>
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "windows_helper_protocol.h"

namespace pty_helper {
namespace {
constexpr DWORD kPipeFlags = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
constexpr DWORD kFirstInstance = FILE_FLAG_FIRST_PIPE_INSTANCE;
constexpr DWORD kCreateUnicodeEnvironment = 0x00000400;
constexpr DWORD kExtendedStartupInfo = 0x00080000;
constexpr DWORD kStartfUseStdHandles = 0x00000100;
constexpr DWORD kJobObjectExtendedLimitInformation = 9;
constexpr DWORD kJobObjectLimitKillOnJobClose = 0x00002000;
constexpr DWORD kProcThreadAttributePseudoConsole = 0x00020016;
constexpr DWORD kProcThreadAttributeJobList = 0x0002000d;
constexpr size_t kMaxQueuedCommands = 1024;

HANDLE g_input = INVALID_HANDLE_VALUE;
HANDLE g_output = INVALID_HANDLE_VALUE;
HANDLE g_job = nullptr;
HANDLE g_process = nullptr;
HANDLE g_thread = nullptr;
HANDLE g_commandEvent = nullptr;
HANDLE g_reader = nullptr;
HPCON g_conpty = nullptr;
CRITICAL_SECTION g_queueLock;
std::vector<QueuedCommand> g_commands;
std::atomic<bool> g_parentGone{false};
std::atomic<bool> g_readerFailed{false};
std::atomic<bool> g_stopReader{false};
bool g_closeRequested = false;
bool g_queueInitialized = false;
std::atomic<uint32_t> g_terminationSignal{0};
}

std::string WinError(const char* operation) {
  return std::string(operation) + " failed with Win32 error " + std::to_string(GetLastError());
}

void Close(HANDLE* handle) {
  if (*handle && *handle != INVALID_HANDLE_VALUE) CloseHandle(*handle);
  *handle = nullptr;
}

void StopReader() {
  if (!g_reader) return;
  g_stopReader = true;
  CancelSynchronousIo(g_reader);
  if (WaitForSingleObject(g_reader, 0) == WAIT_OBJECT_0) Close(&g_reader);
}

[[noreturn]] void AbortHelper() {
  TerminateJob(1);
  ExitProcess(1);
}

void CloseJob() {
  HANDLE job = nullptr;
  if (g_queueInitialized) EnterCriticalSection(&g_queueLock);
  job = g_job;
  g_job = nullptr;
  if (g_queueInitialized) LeaveCriticalSection(&g_queueLock);
  if (job) CloseHandle(job);
}

bool TerminateJob(DWORD code) {
  if (g_queueInitialized) EnterCriticalSection(&g_queueLock);
  const HANDLE job = g_job;
  const BOOL terminated = job && TerminateJobObject(job, code);
  const DWORD error = terminated ? ERROR_SUCCESS : GetLastError();
  if (g_queueInitialized) LeaveCriticalSection(&g_queueLock);
  if (!terminated) SetLastError(error);
  return terminated != FALSE;
}

void Cleanup() {
  CloseJob();
  StopReader();
  const bool readerStopped = !g_reader;
  if (g_process) {
    WaitForSingleObject(g_process, 5000);
    CloseHandle(g_process);
    g_process = nullptr;
  }
  if (g_thread) Close(&g_thread);
  if (g_conpty) {
    ClosePseudoConsole(g_conpty);
    g_conpty = nullptr;
  }
  if (g_input != INVALID_HANDLE_VALUE) CloseHandle(g_input);
  if (g_output != INVALID_HANDLE_VALUE) CloseHandle(g_output);
  g_input = g_output = INVALID_HANDLE_VALUE;
  if (readerStopped) {
    Close(&g_commandEvent);
    if (g_queueInitialized) {
      DeleteCriticalSection(&g_queueLock);
      g_queueInitialized = false;
    }
  }
}

bool Fail(const std::string& message) {
  WriteUtf8(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Error, 0, message);
  return false;
}

HANDLE CreatePipe(const std::wstring& name) {
  HANDLE handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | kFirstInstance,
                                   kPipeFlags, 1, 65536, 65536, 0, nullptr);
  if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error(WinError("CreateNamedPipeW"));
  return handle;
}

bool Connect(HANDLE pipe) {
  if (ConnectNamedPipe(pipe, nullptr)) return true;
  return GetLastError() == ERROR_PIPE_CONNECTED;
}

bool CreateTarget(const StartOptions& options, uint32_t* pid) {
  g_input = CreatePipe(options.inputName);
  g_output = CreatePipe(options.outputName);
  if (!WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Pipes, 0, nullptr, 0)) return false;
  Frame connected{};
  if (!ReadFrame(GetStdHandle(STD_INPUT_HANDLE), &connected) || connected.opcode != Opcode::Connected ||
      connected.id != 0 || !connected.payload.empty()) return false;
  if (!Connect(g_input) || !Connect(g_output)) throw std::runtime_error(WinError("ConnectNamedPipe"));

  COORD size{static_cast<SHORT>(options.cols), static_cast<SHORT>(options.rows)};
  HRESULT result = CreatePseudoConsole(size, g_input, g_output, 0, &g_conpty);
  if (FAILED(result)) throw std::runtime_error("CreatePseudoConsole failed with HRESULT " + std::to_string(static_cast<uint32_t>(result)));

  g_job = CreateJobObjectW(nullptr, nullptr);
  if (!g_job) throw std::runtime_error(WinError("CreateJobObjectW"));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo{};
  jobInfo.BasicLimitInformation.LimitFlags = kJobObjectLimitKillOnJobClose;
  if (!SetInformationJobObject(g_job, static_cast<JOBOBJECTINFOCLASS>(kJobObjectExtendedLimitInformation),
                               &jobInfo, static_cast<DWORD>(sizeof(jobInfo)))) throw std::runtime_error(WinError("SetInformationJobObject"));

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  if (!attributeBytes || attributeBytes > 65536) throw std::runtime_error("Invalid process attribute list size");
  std::vector<uint8_t> attributes(attributeBytes);
  auto* attributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(attributeList, 2, 0, &attributeBytes)) throw std::runtime_error(WinError("InitializeProcThreadAttributeList"));
  HANDLE jobList[] = {g_job};
  bool attributesReady = true;
  auto deleteAttributes = [&]() {
    if (attributesReady) {
      DeleteProcThreadAttributeList(attributeList);
      attributesReady = false;
    }
  };
  if (!UpdateProcThreadAttribute(attributeList, 0, kProcThreadAttributePseudoConsole, g_conpty, sizeof(g_conpty), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributeList, 0, kProcThreadAttributeJobList, jobList, sizeof(jobList), nullptr, nullptr)) {
    const auto error = WinError("UpdateProcThreadAttribute");
    deleteAttributes();
    throw std::runtime_error(error);
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = kStartfUseStdHandles;
  startup.lpAttributeList = attributeList;
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> command(options.commandLine.begin(), options.commandLine.end());
  command.push_back(L'\0');
  const BOOL created = CreateProcessW(options.application.c_str(), command.data(), nullptr, nullptr,
                                      FALSE, kExtendedStartupInfo | kCreateUnicodeEnvironment,
                                      const_cast<wchar_t*>(options.environment.data()), options.cwd.c_str(),
                                      &startup.StartupInfo, &process);
  if (!created) {
    const auto error = WinError("CreateProcessW");
    deleteAttributes();
    throw std::runtime_error(error);
  }
  deleteAttributes();
  g_process = process.hProcess;
  g_thread = process.hThread;
  Close(&g_thread);
  CloseHandle(g_input);
  CloseHandle(g_output);
  g_input = g_output = INVALID_HANDLE_VALUE;
  *pid = process.dwProcessId;
  return true;
}

void Queue(const QueuedCommand& command) {
  EnterCriticalSection(&g_queueLock);
  if (g_commands.size() >= kMaxQueuedCommands) g_readerFailed = true;
  else g_commands.push_back(command);
  LeaveCriticalSection(&g_queueLock);
  SetEvent(g_commandEvent);
}

DWORD WINAPI ReadCommands(void*) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  while (!g_stopReader) {
    Frame frame{};
    if (!ReadFrame(input, &frame)) {
      if (g_stopReader) return 0;
      g_parentGone = true;
      AbortHelper();
    }
    QueuedCommand command{frame.opcode, frame.id, 0, 0};
    if (frame.opcode == Opcode::Resize) {
      if (frame.payload.size() != 8) g_readerFailed = true;
      else {
        std::memcpy(&command.first, frame.payload.data(), 4);
        std::memcpy(&command.second, frame.payload.data() + 4, 4);
      }
    } else if (frame.opcode == Opcode::Kill) {
      if (frame.payload.size() != 4) g_readerFailed = true;
      else std::memcpy(&command.first, frame.payload.data(), 4);
    } else if ((frame.opcode == Opcode::Close || frame.opcode == Opcode::Abort) && frame.payload.empty()) {
      // No payload.
    } else {
      g_readerFailed = true;
    }
    if (g_readerFailed) {
      AbortHelper();
    }
    Queue(command);
    if (g_readerFailed) {
      AbortHelper();
    }
  }
  return 0;
}

bool Ack(uint32_t id, const std::string& error) {
  return WriteUtf8(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Ack, id, error);
}

bool RunTarget(uint32_t pid) {
  if (!WriteU32(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Spawned, 0, pid)) return false;
  InitializeCriticalSection(&g_queueLock);
  g_queueInitialized = true;
  g_commandEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_commandEvent) return Fail(WinError("CreateEventW"));
  g_reader = CreateThread(nullptr, 0, ReadCommands, nullptr, 0, nullptr);
  if (!g_reader) return Fail(WinError("CreateThread"));

  bool done = false;
  while (!done) {
    if (g_parentGone || g_readerFailed) {
      g_terminationSignal = 1;
      CloseJob();
      break;
    }
    const DWORD processState = WaitForSingleObject(g_process, 0);
    if (processState == WAIT_FAILED) return Fail(WinError("WaitForSingleObject"));
    if (processState == WAIT_OBJECT_0) {
      EnterCriticalSection(&g_queueLock);
      const bool hasCommands = !g_commands.empty();
      LeaveCriticalSection(&g_queueLock);
      if (!hasCommands) break;
    }
    const DWORD eventState = WaitForSingleObject(g_commandEvent, processState == WAIT_OBJECT_0 ? 0 : 50);
    if (eventState == WAIT_TIMEOUT) continue;
    if (eventState != WAIT_OBJECT_0) return Fail(WinError("WaitForSingleObject(command event)"));
    if (g_parentGone || g_readerFailed) {
      g_terminationSignal = 1;
      CloseJob();
      break;
    }
    ResetEvent(g_commandEvent);
    std::vector<QueuedCommand> commands;
    EnterCriticalSection(&g_queueLock);
    commands.swap(g_commands);
    LeaveCriticalSection(&g_queueLock);
    for (const auto& command : commands) {
      std::string error;
      if (command.opcode == Opcode::Resize) {
        if (command.first == 0 || command.second == 0 || command.first > 32767 || command.second > 32767) {
          error = "invalid terminal dimensions";
        } else {
          const COORD size{static_cast<SHORT>(command.first), static_cast<SHORT>(command.second)};
          const HRESULT result = ResizePseudoConsole(g_conpty, size);
          if (FAILED(result)) error = "ResizePseudoConsole failed with HRESULT " + std::to_string(static_cast<uint32_t>(result));
        }
      } else if (command.opcode == Opcode::Kill || command.opcode == Opcode::Close || command.opcode == Opcode::Abort) {
        g_terminationSignal = command.opcode == Opcode::Kill ? command.first : 1;
        if (!TerminateJob(1)) error = WinError("TerminateJobObject");
        else if (command.opcode == Opcode::Close || command.opcode == Opcode::Abort) g_closeRequested = true;
      } else {
        error = "unexpected helper command";
      }
      if (!Ack(command.id, error)) return false;
      if (!error.empty() && command.opcode == Opcode::Abort) return false;
    }
    if (g_closeRequested) done = true;
  }

  DWORD exitCode = 0;
  if (WaitForSingleObject(g_process, INFINITE) != WAIT_OBJECT_0) return Fail(WinError("waiting for target exit"));
  if (!GetExitCodeProcess(g_process, &exitCode)) return Fail(WinError("GetExitCodeProcess"));
  // Closing the job first kills descendants that still hold ConPTY endpoints.
  CloseJob();
  if (g_process) {
    CloseHandle(g_process);
    g_process = nullptr;
  }
  if (g_conpty) {
    ClosePseudoConsole(g_conpty);
    g_conpty = nullptr;
  }
  uint32_t status[] = {exitCode, g_terminationSignal.load()};
  return WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Exited, 0, status, static_cast<uint32_t>(sizeof(status)));
}

int RunHelper() {
  try {
    Frame start{};
    StartOptions options{};
    if (!ReadFrame(GetStdHandle(STD_INPUT_HANDLE), &start) || !ParseStart(start, &options)) {
      return Fail("invalid helper START frame") ? 0 : 1;
    }
    uint32_t pid = 0;
    if (!CreateTarget(options, &pid)) throw std::runtime_error("parent disconnected during helper startup");
    if (!RunTarget(pid)) throw std::runtime_error("helper control stream failed");
    Cleanup();
    WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Done, 0, nullptr, 0);
    return 0;
  } catch (const std::exception& error) {
    Fail(error.what());
    Cleanup();
    WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), Opcode::Done, 0, nullptr, 0);
    return 1;
  }
}

}  // namespace pty_helper

int wmain() {
  const int result = pty_helper::RunHelper();
  ExitProcess(static_cast<UINT>(result));
}
