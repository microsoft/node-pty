/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 */

#include <iostream>
#include <nan.h>
#include <Shlwapi.h> // PathCombine, PathIsRelative
#include <sstream>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <winpty.h>
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"
#include "..\..\deps\winpty\src\shared\GenRandom.h"
#include "..\..\deps\winpty\src\shared\StringBuilder.h"
/**
* Misc
*/
extern "C" void init(v8::Handle<v8::Object>);

#define WINPTY_DBG_VARIABLE TEXT("WINPTYDBG")

/**
* winpty
*/
static std::vector<winpty_t *> ptyHandles;
static volatile LONG ptyCounter;

/**
* Helpers
*/

static winpty_t *get_pipe_handle(int handle) {
  for (size_t i = 0; i < ptyHandles.size(); ++i) {
    winpty_t *ptyHandle = ptyHandles[i];
    int current = (int)winpty_agent_process(ptyHandle);
    if (current == handle) {
      return ptyHandle;
    }
  }
  return nullptr;
}

static bool remove_pipe_handle(int handle) {
  for (size_t i = 0; i < ptyHandles.size(); ++i) {
    winpty_t *ptyHandle = ptyHandles[i];
    if ((int)winpty_agent_process(ptyHandle) == handle) {
      winpty_free(ptyHandle);
      ptyHandles.erase(ptyHandles.begin() + i);
      ptyHandle = nullptr;
      return true;
    }
  }
  return false;
}

void throw_winpty_error(const char *generalMsg, winpty_error_ptr_t error_ptr) {
  std::stringstream why;
  std::wstring msg(winpty_error_msg(error_ptr));
  std::string msg_(msg.begin(), msg.end());
  why << generalMsg << ": " << msg_;
  Nan::ThrowError(why.str().c_str());
  winpty_error_free(error_ptr);
}

static NAN_METHOD(PtyGetExitCode) {
  Nan::HandleScope scope;

  if (info.Length() != 1 ||
      !info[0]->IsNumber()) {
    Nan::ThrowError("Usage: pty.getExitCode(pidHandle)");
    return;
  }

  DWORD exitCode = 0;
  GetExitCodeProcess((HANDLE)info[0]->IntegerValue(), &exitCode);

  info.GetReturnValue().Set(Nan::New<v8::Number>(exitCode));
}

static NAN_METHOD(PtyGetProcessList) {
  Nan::HandleScope scope;

  if (info.Length() != 1 ||
      !info[0]->IsNumber()) {
    Nan::ThrowError("Usage: pty.getProcessList(pid)");
    return;
  }

  int pid = info[0]->Int32Value();

  winpty_t *pc = get_pipe_handle(pid);
  if (pc == nullptr) {
    info.GetReturnValue().Set(Nan::New<v8::Array>(0));
    return;
  }
  int processList[64];
  const int processCount = 64;
  int actualCount = winpty_get_console_process_list(pc, processList, processCount, nullptr);

  v8::Local<v8::Array> result = Nan::New<v8::Array>(actualCount);
  for (uint32_t i = 0; i < actualCount; i++) {
    Nan::Set(result, i, Nan::New<v8::Number>(processList[i]));
  }
  info.GetReturnValue().Set(result);
}

HANDLE hIn, hOut, hpc;

// Returns a new server named pipe.  It has not yet been connected.
bool createDataServerPipe(bool write, std::wstring kind, HANDLE *hRead, HANDLE *hWrite, std::wstring &name)
{
  name = L"\\\\.\\pipe\\conpty2-" + kind;

  // const DWORD winOpenMode = ((openMode & OpenMode::Reading) ? PIPE_ACCESS_INBOUND : 0) | ((openMode & OpenMode::Writing) ? PIPE_ACCESS_OUTBOUND : 0) | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED;
  const DWORD winOpenMode =  PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE/*  | FILE_FLAG_OVERLAPPED */;
  // const auto sd = createPipeSecurityDescriptorOwnerFullControl();
  // ASSERT(sd && "error creating data pipe SECURITY_DESCRIPTOR");
  SECURITY_ATTRIBUTES sa = {};
  sa.nLength = sizeof(sa);
  // sa.lpSecurityDescriptor = sd.get();
  *hRead = CreateNamedPipeW(
      name.c_str(),
      /*dwOpenMode=*/winOpenMode,
      /*dwPipeMode=*/PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      /*nMaxInstances=*/1,
      /*nOutBufferSize=*/0,
      /*nInBufferSize=*/0,
      /*nDefaultTimeOut=*/30000,
      &sa);

  // *hWrite = CreateFileW(name.c_str(), GENERIC_READ|GENERIC_WRITE, 0, 0, OPEN_EXISTING, 0, 0);
  wprintf(L"%s:%x\n", name.c_str(), *hRead);
  // Start an asynchronous connection attempt.
  // m_connectEvent = createEvent();

  // HANDLE ret = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  // OVERLAPPED m_connectOver = {};
  // memset(&m_connectOver, 0, sizeof(m_connectOver));
  // m_connectOver.hEvent = ret;
  // BOOL success = ConnectNamedPipe(*hRead, &m_connectOver);
  // printf("ConnectNamedPipe: %d\n", success);
  // const auto err = GetLastError();
  // printf("ConnectNamedPipe: %d\n", err);

  // if (!success && err == ERROR_PIPE_CONNECTED)
  // {
  //   success = TRUE;
  // }
  // if (success)
  // {
  //   // TRACE("Server pipe [%s] connected", utf8FromWide(name).c_str());
  //   // m_connectEvent.dispose();
  //   CloseHandle(ret);
  //   // startPipeWorkers();
  // }
  // else if (err != ERROR_IO_PENDING)
  // {
  //   // ASSERT(false && "ConnectNamedPipe call failed");
  //   // return false;
  // }

  // ConnectNamedPipe(*hRead, nullptr);
  // return success;
  return true;
  // NamedPipe &pipe = createNamedPipe();
  // pipe.openServerPipe(
  //     name.c_str(),
  //     write ? NamedPipe::OpenMode::Writing
  //           : NamedPipe::OpenMode::Reading,
  //     write ? 8192 : 0,
  //     write ? 0 : 256);
  // if (!write)
  // {
  //   pipe.setReadBufferSize(64 * 1024);
  // }
  // return pipe;
}

typedef bool (*PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hin, HANDLE hout, DWORD dwFlags, void* phpcon);

HRESULT CreatePseudoConsoleAndHandles(COORD size,
                                      _In_ DWORD dwFlags,
                                      _Out_ HANDLE *phInput,
                                      _Out_ HANDLE *phOutput,
                                      _Out_ void *phPC, std::wstring& inName, std::wstring& outName)
{

  HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
  bool fLoadedDll = hLibrary != nullptr;
  bool success = false;
  if (fLoadedDll)
  {
    PFNCREATEPSEUDOCONSOLE const pfnCreate = (PFNCREATEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "CreatePseudoConsole");
    if (pfnCreate)
    {
      if (phPC == NULL || phInput == NULL || phOutput == NULL)
      {
        return E_INVALIDARG;
      }

      HANDLE outPipeOurSide;
      HANDLE inPipeOurSide;
      // HANDLE outPipePseudoConsoleSide;
      // HANDLE inPipePseudoConsoleSide;
      success = createDataServerPipe(true, L"in", &hIn, &inPipeOurSide, inName);
      printf("createDataServerPipe0 %d;\n", success);
      success = createDataServerPipe(true, L"out", &hOut, &outPipeOurSide, outName);
      printf("createDataServerPipe1 %d;\n", success);

      return pfnCreate(size, hIn, hOut, dwFlags, phPC);
    }
    else{

      printf("Failed to load PFNCREATEPSEUDOCONSOLE\n");
    }

  }

  else
  {
    printf("Failed to load kernel32.dll\n");
  }

  return E_FAIL;

}

static NAN_METHOD(PtyStartProcess) {
  Nan::HandleScope scope;

  // HANDLE hpc;
  HANDLE hIn, hOut;
  std::wstring inName, outName, str_cmdline;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};

  DWORD dwExit = 0;

  if (info.Length() != 7 ||
      !info[0]->IsString() ||
      !info[1]->IsString() ||
      !info[2]->IsArray() ||
      !info[3]->IsString() ||
      !info[4]->IsNumber() ||
      !info[5]->IsNumber() ||
      !info[6]->IsBoolean()) {
    Nan::ThrowError("Usage: pty.startProcess(file, cmdline, env, cwd, cols, rows, debug)");
    return;
  }

  std::stringstream why;

  const wchar_t *filename = path_util::to_wstring(v8::String::Utf8Value(info[0]->ToString()));
  const wchar_t *cmdline = path_util::to_wstring(v8::String::Utf8Value(info[1]->ToString()));
  const wchar_t *cwd = path_util::to_wstring(v8::String::Utf8Value(info[3]->ToString()));

  // create environment block
  std::wstring env;
  const v8::Handle<v8::Array> envValues = v8::Handle<v8::Array>::Cast(info[2]);
  if (!envValues.IsEmpty()) {

    std::wstringstream envBlock;

    for(uint32_t i = 0; i < envValues->Length(); i++) {
      std::wstring envValue(path_util::to_wstring(v8::String::Utf8Value(envValues->Get(i)->ToString())));
      envBlock << envValue << L'\0';
    }

    env = envBlock.str();
  }

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if (::PathIsRelativeW(filename)) {
    shellpath = path_util::get_shell_path(filename);
  } else {
    shellpath = filename;
  }

  std::string shellpath_(shellpath.begin(), shellpath.end());

  if (shellpath.empty() || !path_util::file_exists(shellpath)) {
    why << "File not found: " << shellpath_;
    Nan::ThrowError(why.str().c_str());
    goto cleanup;
  }

  int cols = info[4]->Int32Value();
  int rows = info[5]->Int32Value();
  bool debug = info[6]->ToBoolean()->IsTrue();

  fSuccess = CreatePseudoConsoleAndHandles({(SHORT)cols, (SHORT)rows}, 0, &hIn, &hOut, (void *)&hpc, inName, outName);
  if (fSuccess)
  {
    wprintf(L"succeeded:CreatePseudoConsoleAndHandles\n");
  }
  else
  {
    auto gle = GetLastError();
    wprintf(L"CreatePseudoConsoleAndHandles GLE:%d\n", gle);
  }



  // Enable/disable debugging
  SetEnvironmentVariable(WINPTY_DBG_VARIABLE, debug ? "1" : NULL); // NULL = deletes variable

  // Create winpty config
  winpty_error_ptr_t error_ptr = nullptr;
  winpty_config_t* winpty_config = winpty_config_new(0, &error_ptr);
  if (winpty_config == nullptr) {
    throw_winpty_error("Error creating WinPTY config", error_ptr);
    goto cleanup;
  }
  winpty_error_free(error_ptr);

  // Set pty size on config
  winpty_config_set_initial_size(winpty_config, cols, rows);

  // Start the pty agent
  winpty_t *pc = winpty_open(winpty_config, &error_ptr);
  winpty_config_free(winpty_config);
  if (pc == nullptr) {
    throw_winpty_error("Error launching WinPTY agent", error_ptr);
    goto cleanup;
  }
  winpty_error_free(error_ptr);

  // Save pty struct for later use
  ptyHandles.insert(ptyHandles.end(), pc);

  // Create winpty spawn config
  winpty_spawn_config_t* config = winpty_spawn_config_new(WINPTY_SPAWN_FLAG_AUTO_SHUTDOWN, shellpath.c_str(), cmdline, cwd, env.c_str(), &error_ptr);
  if (config == nullptr) {
    throw_winpty_error("Error creating WinPTY spawn config", error_ptr);
    goto cleanup;
  }
  winpty_error_free(error_ptr);

  // Spawn the new process
  HANDLE handle = nullptr;
  BOOL spawnSuccess = winpty_spawn(pc, config, &handle, nullptr, nullptr, &error_ptr);
  winpty_spawn_config_free(config);
  if (!spawnSuccess) {
    throw_winpty_error("Unable to start terminal process", error_ptr);
    goto cleanup;
  }
  winpty_error_free(error_ptr);

  // Set return values
  v8::Local<v8::Object> marshal = Nan::New<v8::Object>();
  marshal->Set(Nan::New<v8::String>("innerPid").ToLocalChecked(), Nan::New<v8::Number>((int)GetProcessId(handle)));
  marshal->Set(Nan::New<v8::String>("innerPidHandle").ToLocalChecked(), Nan::New<v8::Number>((int)handle));
  marshal->Set(Nan::New<v8::String>("pid").ToLocalChecked(), Nan::New<v8::Number>((int)winpty_agent_process(pc)));
  marshal->Set(Nan::New<v8::String>("pty").ToLocalChecked(), Nan::New<v8::Number>(InterlockedIncrement(&ptyCounter)));
  marshal->Set(Nan::New<v8::String>("fd").ToLocalChecked(), Nan::New<v8::Number>(-1));
  {
    // LPCWSTR coninPipeName = winpty_conin_name(pc);
    // std::wstring coninPipeNameWStr(coninPipeName);
    std::string coninPipeNameStr(inName.begin(), inName.end());
    // marshal->Set(Nan::New<v8::String>("conin").ToLocalChecked(), Nan::New<v8::String>(coninPipeNameStr).ToLocalChecked());
    marshal->Set(Nan::New<v8::String>("conin").ToLocalChecked(), Nan::New<v8::String>(coninPipeNameStr).ToLocalChecked());
    // LPCWSTR conoutPipeName = winpty_conout_name(pc);
    // std::wstring conoutPipeNameWStr(conoutPipeName);
    std::string conoutPipeNameStr(outName.begin(), outName.end());
    // marshal->Set(Nan::New<v8::String>("conout").ToLocalChecked(), Nan::New<v8::String>(conoutPipeNameStr).ToLocalChecked());
    marshal->Set(Nan::New<v8::String>("conout").ToLocalChecked(), Nan::New<v8::String>(conoutPipeNameStr).ToLocalChecked());
  }
  info.GetReturnValue().Set(marshal);

  goto cleanup;

cleanup:
  delete filename;
  delete cmdline;
  delete cwd;
}

static NAN_METHOD(PtyConnect) {
  std::wstring str_cmdline;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};
  BOOL success = ConnectNamedPipe(hIn, nullptr);
  // if (success)
  // {
  //   wprintf(L"succeeded:ConnectNamedPipe\n");
  // }
  // else
  // {
  //   wprintf(L"GLE:ConnectNamedPipe%d\n", GetLastError());
  // }
  success = ConnectNamedPipe(hOut, nullptr);
  // if (success)
  // {
  //   wprintf(L"succeeded:ConnectNamedPipe\n");
  // }
  // else
  // {
  //   wprintf(L"GLE:ConnectNamedPipe%d\n", GetLastError());
  // }

  auto foo = ProcThreadAttributeValue(22, FALSE, TRUE, FALSE);

  STARTUPINFOEXW siEx;
  siEx = {0};
  siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  size_t size;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  BYTE *attrList = new BYTE[size];
  printf("size:%d", size);
  siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList);

  fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 1, 0, (PSIZE_T)&size);
  // if (fSuccess)
  // {
  //   wprintf(L"succeeded:InitializeProcThreadAttributeList\n");
  // }
  // else
  // {
  //   auto gle = GetLastError();
  //   wprintf(L"InitializeProcThreadAttributeList GLE:%d\n", gle);
  // }

  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       foo,
                                       hpc,
                                       sizeof(void*),
                                       NULL,
                                       NULL);
  if (fSuccess)
  {
    wprintf(L"succeeded:UpdateProcThreadAttribute\n");
  }
  else
  {
    auto gle = GetLastError();
    wprintf(L"UpdateProcThreadAttribute GLE:%d\n", gle);
  }

  // str_cmdline = cmdline;
  // str_cmdline = L"c:\\windows\\system32\\cmd.exe";
  str_cmdline = L"powershell.exe";
  mutableCommandline = std::make_unique<wchar_t[]>(str_cmdline.length() + 1);
  // THROW_IF_NULL_ALLOC(mutableCommandline);

  HRESULT hr = StringCchCopyW(mutableCommandline.get(), str_cmdline.length() + 1, str_cmdline.c_str());
  // THROW_IF_FAILED(hr);
  // DebugBreak();

  fSuccess = !!CreateProcessW(
      nullptr,
      mutableCommandline.get(),
      nullptr,                      // lpProcessAttributes
      nullptr,                      // lpThreadAttributes
      false,                         // bInheritHandles
      EXTENDED_STARTUPINFO_PRESENT, // dwCreationFlags
      nullptr,                      // lpEnvironment
      nullptr,                      // lpCurrentDirectory
      &siEx.StartupInfo,            // lpStartupInfo
      &_piClient                    // lpProcessInformation
  );
  // if (fSuccess)
  // {
  //   wprintf(L"succeeded:CreateProcessW\n");
  // }
  // else
  // {
  //   wprintf(L"GLE:CreateProcessW%d\n", GetLastError());
  // }
  // wprintf(L"_piClient.hProcess %x\n", _piClient.hProcess);
  // wprintf(L"_piClient.hThread %x\n", _piClient.hThread);
  // wprintf(L"_piClient.dwProcessId %d\n", _piClient.dwProcessId);
  // wprintf(L"_piClient.dwThreadId %d\n", _piClient.dwThreadId);
  // WaitForSingleObject(_piClient.hProcess, 2000);
  // GetExitCodeProcess(_piClient.hProcess, &dwExit);
  // wprintf(L"_piClient.dwExit %d\n", dwExit);

}

static NAN_METHOD(PtyResize) {
  Nan::HandleScope scope;

  if (info.Length() != 3 ||
      !info[0]->IsNumber() ||
      !info[1]->IsNumber() ||
      !info[2]->IsNumber()) {
    Nan::ThrowError("Usage: pty.resize(pid, cols, rows)");
    return;
  }

  int handle = info[0]->Int32Value();
  int cols = info[1]->Int32Value();
  int rows = info[2]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);

  if (pc == nullptr) {
    Nan::ThrowError("The pty doesn't appear to exist");
    return;
  }
  BOOL success = winpty_set_size(pc, cols, rows, nullptr);
  if (!success) {
    Nan::ThrowError("The pty could not be resized");
    return;
  }

  return info.GetReturnValue().SetUndefined();
}

static NAN_METHOD(PtyKill) {
  Nan::HandleScope scope;

  if (info.Length() != 2 ||
      !info[0]->IsNumber() ||
      !info[1]->IsNumber()) {
    Nan::ThrowError("Usage: pty.kill(pid, innerPidHandle)");
    return;
  }

  int handle = info[0]->Int32Value();
  HANDLE innerPidHandle = (HANDLE)info[1]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);
  if (pc == nullptr) {
    Nan::ThrowError("Pty seems to have been killed already");
    return;
  }

  assert(remove_pipe_handle(handle));
  CloseHandle(innerPidHandle);

  return info.GetReturnValue().SetUndefined();
}

/**
* Init
*/

extern "C" void init(v8::Handle<v8::Object> target) {
  Nan::HandleScope scope;
  Nan::SetMethod(target, "startProcess", PtyStartProcess);
  Nan::SetMethod(target, "connect", PtyConnect);
  Nan::SetMethod(target, "resize", PtyResize);
  Nan::SetMethod(target, "kill", PtyKill);
  Nan::SetMethod(target, "getExitCode", PtyGetExitCode);
  Nan::SetMethod(target, "getProcessList", PtyGetProcessList);
};

NODE_MODULE(pty, init);
