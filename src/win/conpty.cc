/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 */

#define _WIN32_WINNT 0x600

#define NODE_ADDON_API_DISABLE_DEPRECATED
#include <napi.h>
#include <assert.h>
#include <Shlwapi.h> // PathCombine, PathIsRelative
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"

// Taken from the RS5 Windows SDK, but redefined here in case we're targeting <= 17134
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)

typedef VOID* HPCON;
typedef HRESULT (__stdcall *PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hIn, HANDLE hOut, DWORD dwFlags, HPCON* phpcon);
typedef HRESULT (__stdcall *PFNRESIZEPSEUDOCONSOLE)(HPCON hpc, COORD newSize);
typedef HRESULT (__stdcall *PFNCLEARPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);

#endif

struct pty_baton {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;

  HANDLE hShell;

  pty_baton(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc) : id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc) {};
};

static std::vector<pty_baton*> ptyHandles;
static volatile LONG ptyCounter;

static pty_baton* get_pty_baton(int id) {
  for (size_t i = 0; i < ptyHandles.size(); ++i) {
    pty_baton* ptyHandle = ptyHandles[i];
    if (ptyHandle->id == id) {
      return ptyHandle;
    }
  }
  return nullptr;
}

static bool remove_pty_baton(int id) {
  for (size_t i = 0; i < ptyHandles.size(); ++i) {
    pty_baton* ptyHandle = ptyHandles[i];
    if (ptyHandle->id == id) {
      ptyHandles.erase(ptyHandles.begin() + i);
      ptyHandle = nullptr;
      return true;
    }
  }
  return false;
}

struct ExitEvent {
  int exit_code = 0;
};

void SetupExitCallback(Napi::Env env, Napi::Function cb, pty_baton* baton) {
  std::thread *th = new std::thread;
  // Don't use Napi::AsyncWorker which is limited by UV_THREADPOOL_SIZE.
  auto tsfn = Napi::ThreadSafeFunction::New(
      env,
      cb,                           // JavaScript function called asynchronously
      "SetupExitCallback_resource", // Name
      0,                            // Unlimited queue
      1,                            // Only one thread will use this initially
      [th](Napi::Env) {   // Finalizer used to clean threads up
        th->join();
        delete th;
      });
  *th = std::thread([tsfn = std::move(tsfn), baton] {
    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *exit_event) {
      cb.Call({Napi::Number::New(env, exit_event->exit_code)});
      delete exit_event;
    };

    ExitEvent *exit_event = new ExitEvent;
    // Wait for process to complete.
    WaitForSingleObject(baton->hShell, INFINITE);
    // Get process exit code.
    GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));
    // Clean up handles
    // Calling DisconnectNamedPipes here or in PtyKill results in a crash,
    // ref https://github.com/microsoft/node-pty/issues/512,
    // so we only call CloseHandle for now.
    CloseHandle(baton->hIn);
    CloseHandle(baton->hOut);

    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread
    assert(status == napi_ok);

    tsfn.Release();
  });
}

Napi::Error errorWithCode(const Napi::CallbackInfo& info, const char* text) {
  std::stringstream errorText;
  errorText << text;
  errorText << ", error code: " << GetLastError();
  return Napi::Error::New(info.Env(), errorText.str());
}

// Returns a new server named pipe.  It has not yet been connected.
bool createDataServerPipe(bool write,
                          std::wstring kind,
                          HANDLE* hServer,
                          std::wstring &name,
                          const std::wstring &pipeName)
{
  *hServer = INVALID_HANDLE_VALUE;

  name = L"\\\\.\\pipe\\" + pipeName + L"-" + kind;

  const DWORD winOpenMode =  PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE/*  | FILE_FLAG_OVERLAPPED */;

  SECURITY_ATTRIBUTES sa = {};
  sa.nLength = sizeof(sa);

  *hServer = CreateNamedPipeW(
      name.c_str(),
      /*dwOpenMode=*/winOpenMode,
      /*dwPipeMode=*/PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      /*nMaxInstances=*/1,
      /*nOutBufferSize=*/0,
      /*nInBufferSize=*/0,
      /*nDefaultTimeOut=*/30000,
      &sa);

  return *hServer != INVALID_HANDLE_VALUE;
}

HRESULT CreateNamedPipesAndPseudoConsole(COORD size,
                                         DWORD dwFlags,
                                         HANDLE *phInput,
                                         HANDLE *phOutput,
                                         HPCON* phPC,
                                         std::wstring& inName,
                                         std::wstring& outName,
                                         const std::wstring& pipeName)
{
  HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
  bool fLoadedDll = hLibrary != nullptr;
  if (fLoadedDll)
  {
    PFNCREATEPSEUDOCONSOLE const pfnCreate = (PFNCREATEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "CreatePseudoConsole");
    if (pfnCreate)
    {
      if (phPC == NULL || phInput == NULL || phOutput == NULL)
      {
        return E_INVALIDARG;
      }

      bool success = createDataServerPipe(true, L"in", phInput, inName, pipeName);
      if (!success)
      {
        return HRESULT_FROM_WIN32(GetLastError());
      }
      success = createDataServerPipe(false, L"out", phOutput, outName, pipeName);
      if (!success)
      {
        return HRESULT_FROM_WIN32(GetLastError());
      }
      return pfnCreate(size, *phInput, *phOutput, dwFlags, phPC);
    }
    else
    {
      // Failed to find CreatePseudoConsole in kernel32. This is likely because
      //    the user is not running a build of Windows that supports that API.
      //    We should fall back to winpty in this case.
      return HRESULT_FROM_WIN32(GetLastError());
    }
  }

  // Failed to find  kernel32. This is realy unlikely - honestly no idea how
  //    this is even possible to hit. But if it does happen, fall back to winpty.
  return HRESULT_FROM_WIN32(GetLastError());
}

static Napi::Value PtyStartProcess(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  Napi::Object marshal;
  std::wstring inName, outName;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};

  if (info.Length() != 6 ||
      !info[0].IsString() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber() ||
      !info[3].IsBoolean() ||
      !info[4].IsString() ||
      !info[5].IsBoolean()) {
    throw Napi::Error::New(env, "Usage: pty.startProcess(file, cols, rows, debug, pipeName, inheritCursor)");
  }

  const std::wstring filename(path_util::to_wstring(info[0].As<Napi::String>()));
  const SHORT cols = static_cast<SHORT>(info[1].As<Napi::Number>().Uint32Value());
  const SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());
  const bool debug = info[3].As<Napi::Boolean>().Value();
  const std::wstring pipeName(path_util::to_wstring(info[4].As<Napi::String>()));
  const bool inheritCursor = info[5].As<Napi::Boolean>().Value();

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if (::PathIsRelativeW(filename.c_str())) {
    shellpath = path_util::get_shell_path(filename.c_str());
  } else {
    shellpath = filename;
  }

  if (shellpath.empty() || !path_util::file_exists(shellpath)) {
    std::string why;
    why += "File not found: ";
    why += path_util::wstring_to_string(shellpath);
    throw Napi::Error::New(env, why);
  }

  HANDLE hIn, hOut;
  HPCON hpc;
  HRESULT hr = CreateNamedPipesAndPseudoConsole({cols, rows}, inheritCursor ? 1/*PSEUDOCONSOLE_INHERIT_CURSOR*/ : 0, &hIn, &hOut, &hpc, inName, outName, pipeName);

  // Restore default handling of ctrl+c
  SetConsoleCtrlHandler(NULL, FALSE);

  // Set return values
  marshal = Napi::Object::New(env);

  if (SUCCEEDED(hr)) {
    // We were able to instantiate a conpty
    const int ptyId = InterlockedIncrement(&ptyCounter);
    marshal.Set("pty", Napi::Number::New(env, ptyId));  
    ptyHandles.insert(ptyHandles.end(), new pty_baton(ptyId, hIn, hOut, hpc));
  } else {
    throw Napi::Error::New(env, "Cannot launch conpty");
  }

  std::string inNameStr = path_util::wstring_to_string(inName);
  if (inNameStr.empty()) {
    throw Napi::Error::New(env, "Failed to initialize conpty conin");
  }
  std::string outNameStr = path_util::wstring_to_string(outName);
  if (outNameStr.empty()) {
    throw Napi::Error::New(env, "Failed to initialize conpty conout");
  }

  marshal.Set("fd", Napi::Number::New(env, -1));
  marshal.Set("conin", Napi::String::New(env, inNameStr));
  marshal.Set("conout", Napi::String::New(env, outNameStr));
  return marshal;
}

static Napi::Value PtyConnect(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  // If we're working with conpty's we need to call ConnectNamedPipe here AFTER
  //    the Socket has attempted to connect to the other end, then actually
  //    spawn the process here.

  std::stringstream errorText;
  BOOL fSuccess = FALSE;

  if (info.Length() != 5 ||
      !info[0].IsNumber() ||
      !info[1].IsString() ||
      !info[2].IsString() ||
      !info[3].IsArray() ||
      !info[4].IsFunction()) {
    throw Napi::Error::New(env, "Usage: pty.connect(id, cmdline, cwd, env, exitCallback)");
  }

  const int id = info[0].As<Napi::Number>().Int32Value();
  const std::wstring cmdline(path_util::to_wstring(info[1].As<Napi::String>()));
  const std::wstring cwd(path_util::to_wstring(info[2].As<Napi::String>()));
  const Napi::Array envValues = info[3].As<Napi::Array>();
  Napi::Function exitCallback = info[4].As<Napi::Function>();

  // Fetch pty handle from ID and start process
  pty_baton* handle = get_pty_baton(id);
  if (!handle) {
    throw Napi::Error::New(env, "Invalid pty handle");
  }

  // Prepare command line
  std::unique_ptr<wchar_t[]> mutableCommandline = std::make_unique<wchar_t[]>(cmdline.length() + 1);
  HRESULT hr = StringCchCopyW(mutableCommandline.get(), cmdline.length() + 1, cmdline.c_str());

  // Prepare cwd
  std::unique_ptr<wchar_t[]> mutableCwd = std::make_unique<wchar_t[]>(cwd.length() + 1);
  hr = StringCchCopyW(mutableCwd.get(), cwd.length() + 1, cwd.c_str());

  // Prepare environment
  std::wstring envStr;
  if (!envValues.IsEmpty()) {
    std::wstring envBlock;
    for(uint32_t i = 0; i < envValues.Length(); i++) {
      envBlock += path_util::to_wstring(envValues.Get(i).As<Napi::String>());
      envBlock += L'\0';
    }
    envBlock += L'\0';
    envStr = std::move(envBlock);
  }
  std::vector<wchar_t> envV(envStr.cbegin(), envStr.cend());
  LPWSTR envArg = envV.empty() ? nullptr : envV.data();

  ConnectNamedPipe(handle->hIn, nullptr);
  ConnectNamedPipe(handle->hOut, nullptr);

  // Attach the pseudoconsole to the client application we're creating
  STARTUPINFOEXW siEx{0};
  siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  siEx.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
  siEx.StartupInfo.hStdError = nullptr;
  siEx.StartupInfo.hStdInput = nullptr;
  siEx.StartupInfo.hStdOutput = nullptr;

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  BYTE *attrList = new BYTE[size];
  siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList);

  fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 1, 0, &size);
  if (!fSuccess) {
    throw errorWithCode(info, "InitializeProcThreadAttributeList failed");
  }
  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                       handle->hpc,
                                       sizeof(HPCON),
                                       NULL,
                                       NULL);
  if (!fSuccess) {
    throw errorWithCode(info, "UpdateProcThreadAttribute failed");
  }

  PROCESS_INFORMATION piClient{};
  fSuccess = !!CreateProcessW(
      nullptr,
      mutableCommandline.get(),
      nullptr,                      // lpProcessAttributes
      nullptr,                      // lpThreadAttributes
      false,                        // bInheritHandles VERY IMPORTANT that this is false
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, // dwCreationFlags
      envArg,                       // lpEnvironment
      mutableCwd.get(),             // lpCurrentDirectory
      &siEx.StartupInfo,            // lpStartupInfo
      &piClient                     // lpProcessInformation
  );
  if (!fSuccess) {
    throw errorWithCode(info, "Cannot create process");
  }

  // Update handle
  handle->hShell = piClient.hProcess;

  SetupExitCallback(env, exitCallback, handle);

  // Return
  auto marshal = Napi::Object::New(env);
  marshal.Set("pid", Napi::Number::New(env, piClient.dwProcessId));
  return marshal;
}

static Napi::Value PtyResize(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 3 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.resize(id, cols, rows)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();
  SHORT cols = static_cast<SHORT>(info[1].As<Napi::Number>().Uint32Value());
  SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());

  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll)
    {
      PFNRESIZEPSEUDOCONSOLE const pfnResizePseudoConsole = (PFNRESIZEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "ResizePseudoConsole");
      if (pfnResizePseudoConsole)
      {
        COORD size = {cols, rows};
        pfnResizePseudoConsole(handle->hpc, size);
      }
    }
  }

  return env.Undefined();
}

static Napi::Value PtyClear(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.clear(id)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();

  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll)
    {
      PFNCLEARPSEUDOCONSOLE const pfnClearPseudoConsole = (PFNCLEARPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "ClearPseudoConsole");
      if (pfnClearPseudoConsole)
      {
        pfnClearPseudoConsole(handle->hpc);
      }
    }
  }

  return env.Undefined();
}

static Napi::Value PtyKill(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.kill(id)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();

  const pty_baton* handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll)
    {
      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "ClosePseudoConsole");
      if (pfnClosePseudoConsole)
      {
        pfnClosePseudoConsole(handle->hpc);
      }
    }

    CloseHandle(handle->hShell);
    assert(remove_pty_baton(id));
  }

  return env.Undefined();
}

/**
* Init
*/

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("startProcess", Napi::Function::New(env, PtyStartProcess));
  exports.Set("connect", Napi::Function::New(env, PtyConnect));
  exports.Set("resize", Napi::Function::New(env, PtyResize));
  exports.Set("clear", Napi::Function::New(env, PtyClear));
  exports.Set("kill", Napi::Function::New(env, PtyKill));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
