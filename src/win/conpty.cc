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
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"


extern "C" void init(v8::Handle<v8::Object>);

// Taken from the RS5 Windows SDK, but redefined here in case we're targeting <= 17134
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)

typedef VOID* HPCON;
typedef HRESULT (*PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hIn, HANDLE hOut, DWORD dwFlags, HPCON* phpcon);
typedef HRESULT (*PFNRESIZEPSEUDOCONSOLE)(HPCON hpc, COORD newSize);
typedef void (*PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);

#endif

// TODO: Pull pty handle stuff into its own class
struct pty_handle {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;
  pty_handle(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc) : id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc) {};
};

static std::vector<pty_handle*> ptyHandles;
static volatile LONG ptyCounter;

static pty_handle* get_pty_handle(int id) {
  for (size_t i = 0; i < ptyHandles.size(); ++i) {
    pty_handle* ptyHandle = ptyHandles[i];
    if (ptyHandle->id == id) {
      return ptyHandle;
    }
  }
  return nullptr;
}

template <typename T>
std::vector<T> vectorFromString(const std::basic_string<T> &str) {
    return std::vector<T>(str.begin(), str.end());
}

void throwNanError(const Nan::FunctionCallbackInfo<v8::Value>* info, const char* text, const bool getLastError) {
  std::stringstream errorText;
  errorText << text;
  if (getLastError) {
    errorText << ", error code: " << GetLastError();
  }
  Nan::ThrowError(errorText.str().c_str());
  (*info).GetReturnValue().SetUndefined();
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

// Returns a new server named pipe.  It has not yet been connected.
bool createDataServerPipe(bool write,
                          std::wstring kind,
                          HANDLE* hServer,
                          std::wstring &name,
                          const std::wstring &pipeName)
{
  *hServer = INVALID_HANDLE_VALUE;

  // TODO generate unique names for each pipe
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

static NAN_METHOD(PtyStartProcess) {
  Nan::HandleScope scope;

  v8::Local<v8::Object> marshal;
  std::wstring inName, outName;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};

  if (info.Length() != 5 ||
      !info[0]->IsString() ||
      !info[1]->IsNumber() ||
      !info[2]->IsNumber() ||
      !info[3]->IsBoolean() ||
      !info[4]->IsString()) {
    Nan::ThrowError("Usage: pty.startProcess(file, cols, rows, debug, pipeName)");
    return;
  }

  const std::wstring filename(path_util::to_wstring(v8::String::Utf8Value(info[0]->ToString())));
  const SHORT cols = info[1]->Uint32Value();
  const SHORT rows = info[2]->Uint32Value();
  const bool debug = info[3]->ToBoolean()->IsTrue();
  const std::wstring pipeName(path_util::to_wstring(v8::String::Utf8Value(info[4]->ToString())));

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if (::PathIsRelativeW(filename.c_str())) {
    shellpath = path_util::get_shell_path(filename.c_str());
  } else {
    shellpath = filename;
  }

  std::string shellpath_(shellpath.begin(), shellpath.end());

  if (shellpath.empty() || !path_util::file_exists(shellpath)) {
    std::stringstream why;
    why << "File not found: " << shellpath_;
    Nan::ThrowError(why.str().c_str());
    return;
  }

  HANDLE hIn, hOut;
  HPCON hpc;
  HRESULT hr = CreateNamedPipesAndPseudoConsole({cols, rows}, 0, &hIn, &hOut, &hpc, inName, outName, pipeName);

  // Set return values
  marshal = Nan::New<v8::Object>();

  if (SUCCEEDED(hr))
  {
    // We were able to instantiate a conpty, yay!
    const int ptyId = InterlockedIncrement(&ptyCounter);
    // TODO: Name this pty "id"
    marshal->Set(Nan::New<v8::String>("pty").ToLocalChecked(), Nan::New<v8::Number>(ptyId));
    ptyHandles.insert(ptyHandles.end(), new pty_handle(ptyId, hIn, hOut, hpc));
  }
  else
  {
    // We weren't able to start conpty. Fall back to winpty.
    // TODO
  }

  // TODO: Pull in innerPid, innerPidHandle(?)
  // marshal->Set(Nan::New<v8::String>("innerPid").ToLocalChecked(), Nan::New<v8::Number>((int)GetProcessId(handle)));
  // marshal->Set(Nan::New<v8::String>("innerPidHandle").ToLocalChecked(), Nan::New<v8::Number>((int)handle));
  // TODO: Pull in pid
  // marshal->Set(Nan::New<v8::String>("pid").ToLocalChecked(), Nan::New<v8::Number>((int)winpty_agent_process(pc)));
  marshal->Set(Nan::New<v8::String>("fd").ToLocalChecked(), Nan::New<v8::Number>(-1));
  {
    // LPCWSTR coninPipeName = winpty_conin_name(pc);
    // std::wstring coninPipeNameWStr(coninPipeName);
    std::string coninPipeNameStr(inName.begin(), inName.end());
    marshal->Set(Nan::New<v8::String>("conin").ToLocalChecked(), Nan::New<v8::String>(coninPipeNameStr).ToLocalChecked());

    // LPCWSTR conoutPipeName = winpty_conout_name(pc);
    // std::wstring conoutPipeNameWStr(conoutPipeName);
    std::string conoutPipeNameStr(outName.begin(), outName.end());
    marshal->Set(Nan::New<v8::String>("conout").ToLocalChecked(), Nan::New<v8::String>(conoutPipeNameStr).ToLocalChecked());
  }
  info.GetReturnValue().Set(marshal);
}

static NAN_METHOD(PtyConnect) {
  Nan::HandleScope scope;

  // If we're working with conpty's we need to call ConnectNamedPipe here AFTER
  //    the Socket has attempted to connect to the other end, then actually
  //    spawn the process here.

  std::stringstream errorText;
  BOOL fSuccess = FALSE;

  if (info.Length() != 4 ||
      !info[0]->IsNumber() ||
      !info[1]->IsString() ||
      !info[2]->IsString() ||
      !info[3]->IsArray()) {
    Nan::ThrowError("Usage: pty.connect(id, cmdline, cwd, env)");
    return;
  }

  const int id = info[0]->Int32Value();
  const std::wstring cmdline(path_util::to_wstring(v8::String::Utf8Value(info[1]->ToString())));
  const std::wstring cwd(path_util::to_wstring(v8::String::Utf8Value(info[2]->ToString())));
  const v8::Handle<v8::Array> envValues = v8::Handle<v8::Array>::Cast(info[3]);

  // Prepare command line
  std::unique_ptr<wchar_t[]> mutableCommandline = std::make_unique<wchar_t[]>(cmdline.length() + 1);
  HRESULT hr = StringCchCopyW(mutableCommandline.get(), cmdline.length() + 1, cmdline.c_str());

  // Prepare cwd
  std::unique_ptr<wchar_t[]> mutableCwd = std::make_unique<wchar_t[]>(cwd.length() + 1);
  hr = StringCchCopyW(mutableCwd.get(), cwd.length() + 1, cwd.c_str());

  // Prepare environment
  std::wstring env;
  if (!envValues.IsEmpty()) {
    std::wstringstream envBlock;
    for(uint32_t i = 0; i < envValues->Length(); i++) {
      std::wstring envValue(path_util::to_wstring(v8::String::Utf8Value(envValues->Get(i)->ToString())));
      envBlock << envValue << L'\0';
    }
    envBlock << L'\0';
    env = envBlock.str();
  }
  auto envV = vectorFromString(env);
  LPWSTR envArg = envV.empty() ? nullptr : envV.data();

  // Fetch pty handle from ID and start process
  const pty_handle* handle = get_pty_handle(id);

  BOOL success = ConnectNamedPipe(handle->hIn, nullptr);
  success = ConnectNamedPipe(handle->hOut, nullptr);

  // Attach the pseudoconsole to the client application we're creating
  STARTUPINFOEXW siEx{0};
  siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  PSIZE_T size;
  InitializeProcThreadAttributeList(NULL, 1, 0, size);
  BYTE *attrList = new BYTE[*size];
  siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList);

  fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 1, 0, size);
  if (!fSuccess) {
    return throwNanError(&info, "InitializeProcThreadAttributeList failed", true);
  }
  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                       handle->hpc,
                                       sizeof(HPCON),
                                       NULL,
                                       NULL);
  if (!fSuccess) {
    return throwNanError(&info, "UpdateProcThreadAttribute failed", true);
  }

  PROCESS_INFORMATION _piClient{};
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
      &_piClient                    // lpProcessInformation
  );
  if (!fSuccess) {
    return throwNanError(&info, "Cannot create process", true);
  }

  v8::Local<v8::Object> marshal = Nan::New<v8::Object>();
  marshal->Set(Nan::New<v8::String>("pid").ToLocalChecked(), Nan::New<v8::Number>(_piClient.dwProcessId));
  info.GetReturnValue().Set(marshal);
}

static NAN_METHOD(PtyResize) {
  Nan::HandleScope scope;

  if (info.Length() != 3 ||
      !info[0]->IsNumber() ||
      !info[1]->IsNumber() ||
      !info[2]->IsNumber()) {
    Nan::ThrowError("Usage: pty.resize(id, cols, rows)");
    return;
  }

  int id = info[0]->Int32Value();
  SHORT cols = info[1]->Uint32Value();
  SHORT rows = info[2]->Uint32Value();

  const pty_handle* handle = get_pty_handle(id);

  // TODO: Share hLibrary between functions
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

  return info.GetReturnValue().SetUndefined();
}

static NAN_METHOD(PtyKill) {
  Nan::HandleScope scope;

  if (info.Length() != 1 ||
      !info[0]->IsNumber()) {
    Nan::ThrowError("Usage: pty.kill(id)");
    return;
  }

  // TODO: If the pty is backed by conpty, call ClosePseudoConsole
  // (using LoadLibrary/GetProcAddress to find ClosePseudoConsole if it exists)

  int id = info[0]->Int32Value();

  const pty_handle* handle = get_pty_handle(id);

  // TODO: Share hLibrary between functions
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
  // Nan::SetMethod(target, "getProcessList", PtyGetProcessList);
};

NODE_MODULE(pty, init);
