#include "windows_helper_protocol.h"

#include <cstring>

namespace pty_helper {
namespace {

struct Header {
  uint32_t magic;
  uint32_t opcode;
  uint32_t id;
  uint32_t bytes;
};
static_assert(sizeof(Header) == 16, "helper protocol header must be 16 bytes");
}

bool ReadExact(HANDLE handle, void* buffer, DWORD bytes) {
  auto* cursor = static_cast<uint8_t*>(buffer);
  DWORD complete = 0;
  while (complete < bytes) {
    DWORD received = 0;
    if (!ReadFile(handle, cursor + complete, bytes - complete, &received, nullptr) || received == 0) return false;
    complete += received;
  }
  return true;
}

bool WriteExact(HANDLE handle, const void* buffer, DWORD bytes) {
  const auto* cursor = static_cast<const uint8_t*>(buffer);
  DWORD complete = 0;
  while (complete < bytes) {
    DWORD sent = 0;
    if (!WriteFile(handle, cursor + complete, bytes - complete, &sent, nullptr) || sent == 0) return false;
    complete += sent;
  }
  return true;
}

bool ReadFrame(HANDLE input, Frame* frame) {
  Header header{};
  if (!ReadExact(input, &header, static_cast<DWORD>(sizeof(header))) || header.magic != kMagic || header.bytes > kMaxPayload) return false;
  frame->opcode = static_cast<Opcode>(header.opcode);
  frame->id = header.id;
  frame->payload.resize(header.bytes);
  return header.bytes == 0 || ReadExact(input, frame->payload.data(), header.bytes);
}

bool WriteFrame(HANDLE output, Opcode opcode, uint32_t id, const void* payload, uint32_t size) {
  if (size > kMaxPayload) return false;
  Header header{kMagic, static_cast<uint32_t>(opcode), id, size};
  return WriteExact(output, &header, static_cast<DWORD>(sizeof(header))) && (size == 0 || WriteExact(output, payload, size));
}

bool ReadU32(const std::vector<uint8_t>& data, size_t* offset, uint32_t* value) {
  if (*offset > data.size() || data.size() - *offset < sizeof(uint32_t)) return false;
  std::memcpy(value, data.data() + *offset, sizeof(uint32_t));
  *offset += sizeof(uint32_t);
  return true;
}

bool ReadWide(const std::vector<uint8_t>& data, size_t* offset, std::wstring* value) {
  uint32_t bytes = 0;
  if (!ReadU32(data, offset, &bytes) || bytes < 2u || (bytes & 1u) != 0 ||
      *offset > data.size() || data.size() - *offset < bytes) return false;
  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t));
  std::memcpy(buffer.data(), data.data() + *offset, bytes);
  *offset += bytes;
  if (buffer.back() != L'\0') return false;
  for (size_t index = 0; index + 1 < buffer.size(); ++index) if (buffer[index] == L'\0') return false;
  value->assign(buffer.data(), buffer.size() - 1);
  return true;
}

bool ReadEnvironment(const std::vector<uint8_t>& data, size_t* offset, std::vector<wchar_t>* value) {
  uint32_t bytes = 0;
  if (!ReadU32(data, offset, &bytes) || bytes < 4u || (bytes & 1u) != 0 ||
      *offset > data.size() || data.size() - *offset < bytes) return false;
  value->resize(bytes / sizeof(wchar_t));
  std::memcpy(value->data(), data.data() + *offset, bytes);
  *offset += bytes;
  if ((*value)[value->size() - 1] != L'\0' || (*value)[value->size() - 2] != L'\0') return false;
  return true;
}

bool ParseStart(const Frame& frame, StartOptions* options) {
  if (frame.opcode != Opcode::Start || frame.id != 0) return false;
  size_t offset = 0;
  if (!ReadU32(frame.payload, &offset, &options->cols) || !ReadU32(frame.payload, &offset, &options->rows) ||
      options->cols == 0 || options->rows == 0 || options->cols > 32767 || options->rows > 32767) return false;
  if (!ReadWide(frame.payload, &offset, &options->application) ||
      !ReadWide(frame.payload, &offset, &options->commandLine) ||
      !ReadWide(frame.payload, &offset, &options->cwd) ||
      !ReadEnvironment(frame.payload, &offset, &options->environment) ||
      !ReadWide(frame.payload, &offset, &options->inputName) ||
      !ReadWide(frame.payload, &offset, &options->outputName)) return false;
  return offset == frame.payload.size();
}

bool WriteU32(HANDLE output, Opcode opcode, uint32_t id, uint32_t value) {
  return WriteFrame(output, opcode, id, &value, sizeof(value));
}

bool WriteUtf8(HANDLE output, Opcode opcode, uint32_t id, const std::string& value) {
  return WriteFrame(output, opcode, id, value.data(), static_cast<uint32_t>(value.size()));
}

}  // namespace pty_helper
