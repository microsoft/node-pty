#pragma once

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>

namespace pty_helper {

constexpr uint32_t kMagic = 0x31595450;
constexpr uint32_t kMaxPayload = 8u * 1024u * 1024u;

enum class Opcode : uint32_t {
  Start = 1,
  Connected = 2,
  Resize = 3,
  Kill = 4,
  Close = 5,
  Abort = 6,
  Pipes = 101,
  Spawned = 102,
  Ack = 103,
  Exited = 104,
  Error = 105,
  Done = 106,
};

struct Frame {
  Opcode opcode;
  uint32_t id;
  std::vector<uint8_t> payload;
};

struct StartOptions {
  uint32_t cols;
  uint32_t rows;
  std::wstring application;
  std::wstring commandLine;
  std::wstring cwd;
  std::vector<wchar_t> environment;
  std::wstring inputName;
  std::wstring outputName;
};

struct QueuedCommand {
  Opcode opcode;
  uint32_t id;
  uint32_t first;
  uint32_t second;
};

bool ReadFrame(HANDLE input, Frame* frame);
bool WriteFrame(HANDLE output, Opcode opcode, uint32_t id, const void* payload, uint32_t size);
bool ReadExact(HANDLE handle, void* buffer, DWORD bytes);
bool WriteExact(HANDLE handle, const void* buffer, DWORD bytes);
bool ParseStart(const Frame& frame, StartOptions* options);
bool ReadU32(const std::vector<uint8_t>& data, size_t* offset, uint32_t* value);
bool ReadWide(const std::vector<uint8_t>& data, size_t* offset, std::wstring* value);
bool ReadEnvironment(const std::vector<uint8_t>& data, size_t* offset, std::vector<wchar_t>* value);
bool WriteU32(HANDLE output, Opcode opcode, uint32_t id, uint32_t value);
bool WriteUtf8(HANDLE output, Opcode opcode, uint32_t id, const std::string& value);
std::string WinError(const char* operation);
void Close(HANDLE* handle);
void StopReader();
[[noreturn]] void AbortHelper();
void Cleanup();
void CloseJob();
bool TerminateJob(DWORD code);
bool Fail(const std::string& message);
HANDLE CreatePipe(const std::wstring& name);
bool Connect(HANDLE pipe);
bool CreateTarget(const StartOptions& options, uint32_t* pid);
void Queue(const QueuedCommand& command);
DWORD WINAPI ReadCommands(void* context);
bool Ack(uint32_t id, const std::string& error = {});
bool RunTarget(uint32_t pid);
int RunHelper();

}  // namespace pty_helper
