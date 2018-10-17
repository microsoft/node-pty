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
// struct pty_handle {
//   int id;
//   HANDLE hIn;
//   HANDLE hOut;
//   pty_handle(int _id, HANDLE _hIn, HANDLE _hOut) : id(_id), hIn(_hIn), hOut(_hOut) {};
// };

// static std::vector<pty_handle*> ptyHandles;
static volatile LONG ptyCounter;

// static pty_handle* get_pty_handle(int id) {
//   for (size_t i = 0; i < ptyHandles.size(); ++i) {
//     pty_handle* ptyHandle = ptyHandles[i];
//     if (ptyHandle->id == id) {
//       return ptyHandle;
//     }
//   }
//   return nullptr;
// }

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

  // winpty_t *pc = get_pipe_handle(pid);
  // if (pc == nullptr) {
    info.GetReturnValue().Set(Nan::New<v8::Array>(0));
    return;
  // }
  // int processList[64];
  // const int processCount = 64;
  // int actualCount = winpty_get_console_process_list(pc, processList, processCount, nullptr);

  // v8::Local<v8::Array> result = Nan::New<v8::Array>(actualCount);
  // for (uint32_t i = 0; i < actualCount; i++) {
  //   Nan::Set(result, i, Nan::New<v8::Number>(processList[i]));
  // }
  // info.GetReturnValue().Set(result);
}

// TODO these should probably not be globals
HANDLE hIn, hOut;
HPCON hpc;

// Returns a new server named pipe.  It has not yet been connected.
bool createDataServerPipe(bool write, std::wstring kind, HANDLE* hServer, std::wstring &name, std::wstring &pipeName)
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
                                         std::wstring& pipeName)
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
  std::wstring inName, outName, str_cmdline, str_pipeName;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};
  std::stringstream why;

  DWORD dwExit = 0;

  if (info.Length() != 7 ||
      !info[0]->IsString() ||
      !info[1]->IsString() ||
      !info[2]->IsString() ||
      !info[3]->IsNumber() ||
      !info[4]->IsNumber() ||
      !info[5]->IsBoolean() ||
      !info[6]->IsString()) {
    Nan::ThrowError("Usage: pty.startProcess(file, cmdline, cwd, cols, rows, debug, pipeName)");
    return;
  }

  const wchar_t *filename = path_util::to_wstring(v8::String::Utf8Value(info[0]->ToString()));
  const wchar_t *cmdline = path_util::to_wstring(v8::String::Utf8Value(info[1]->ToString()));
  const wchar_t *cwd = path_util::to_wstring(v8::String::Utf8Value(info[2]->ToString()));
  const SHORT cols = info[3]->Uint32Value();
  const SHORT rows = info[4]->Uint32Value();
  const bool debug = info[5]->ToBoolean()->IsTrue();
  const wchar_t *pipeName = path_util::to_wstring(v8::String::Utf8Value(info[6]->ToString()));

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

  str_pipeName = pipeName;

  HRESULT hr = CreateNamedPipesAndPseudoConsole({cols, rows}, 0, &hIn, &hOut, &hpc, inName, outName, str_pipeName);

  // Set return values
  marshal = Nan::New<v8::Object>();

  if (SUCCEEDED(hr))
  {
    // We were able to instantiate a conpty, yay!
    const int ptyId = InterlockedIncrement(&ptyCounter);
    // TODO: Name this pty "id"
    marshal->Set(Nan::New<v8::String>("pty").ToLocalChecked(), Nan::New<v8::Number>(ptyId));
    // ptyHandles.insert(ptyHandles.end(), new pty_handle(ptyId, hIn, hOut));
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

  goto cleanup;

cleanup:
  delete filename;
  delete cmdline;
  delete cwd;
}

template <typename T>
std::vector<T> vectorFromString(const std::basic_string<T> &str) {
    return std::vector<T>(str.begin(), str.end());
}


static NAN_METHOD(PtyConnect) {
  Nan::HandleScope scope;

  // If we're working with conpty's we need to call ConnectNamedPipe here AFTER
  //    the Socket has attempted to connect to the other end, then actually
  //    spawn the process here.

  std::wstring str_cmdline;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};
  v8::Local<v8::Object> marshal;

  if (info.Length() != 2 ||
      !info[0]->IsNumber() ||
      !info[1]->IsArray()) {
    Nan::ThrowError("Usage: pty.connect(id, env)");
    return;
  }

  const v8::Handle<v8::Array> envValues = v8::Handle<v8::Array>::Cast(info[1]);

  // Create environment block
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

  BOOL success = ConnectNamedPipe(hIn, nullptr);
  success = ConnectNamedPipe(hOut, nullptr);

  // Attach the pseudoconsole to the client application we're creating
  STARTUPINFOEXW siEx;
  siEx = {0};
  siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  size_t size;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  BYTE *attrList = new BYTE[size];
  siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList);

  fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 1, 0, (PSIZE_T)&size);
  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                       hpc,
                                       sizeof(HPCON),
                                       NULL,
                                       NULL);

  // You need to pass a MUTABLE commandline to CreateProcess, so convert our const wchar_t* here.
  // TODO: Pull in cmdline
  str_cmdline = L"cmd.exe";
  mutableCommandline = std::make_unique<wchar_t[]>(str_cmdline.length() + 1);
  HRESULT hr = StringCchCopyW(mutableCommandline.get(), str_cmdline.length() + 1, str_cmdline.c_str());

  fSuccess = !!CreateProcessW(
      nullptr,
      mutableCommandline.get(),
      nullptr,                      // lpProcessAttributes
      nullptr,                      // lpThreadAttributes
      false,                        // bInheritHandles VERY IMPORTANT that this is false
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, // dwCreationFlags
      envArg,                       // lpEnvironment
      nullptr,                      // lpCurrentDirectory
      &siEx.StartupInfo,            // lpStartupInfo
      &_piClient                    // lpProcessInformation
  );

  // TODO: return the information about the client application out to the caller?
  DWORD error = GetLastError();
  marshal = Nan::New<v8::Object>();

  if (!fSuccess) {
    marshal->Set(Nan::New<v8::String>("error").ToLocalChecked(), Nan::New<v8::Number>(error));
  }

  marshal->Set(Nan::New<v8::String>("pid").ToLocalChecked(), Nan::New<v8::Number>(_piClient.dwProcessId));
  info.GetReturnValue().Set(marshal);
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
  SHORT cols = info[1]->Uint32Value();
  SHORT rows = info[2]->Uint32Value();


  // TODO: Share hLibrary between functions
  HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
  bool fLoadedDll = hLibrary != nullptr;
  if (fLoadedDll)
  {
    PFNRESIZEPSEUDOCONSOLE const pfnResizePseudoConsole = (PFNRESIZEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "ResizePseudoConsole");
    if (pfnResizePseudoConsole)
    {
      COORD size = {cols, rows};
      pfnResizePseudoConsole(hpc, size);
    }
  }

  return info.GetReturnValue().SetUndefined();
}

static NAN_METHOD(PtyKill) {
  Nan::HandleScope scope;

  // TODO: If the pty is backed by conpty, call ClosePseudoConsole
  // (using LoadLibrary/GetProcAddress to find ClosePseudoConsole if it exists)

  // TODO: Share hLibrary between functions
  HANDLE hLibrary = LoadLibraryExW(L"kernel32.dll", 0, 0);
  bool fLoadedDll = hLibrary != nullptr;
  if (fLoadedDll)
  {
    PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "CreatePseudoConsole");
    if (pfnClosePseudoConsole)
    {
      pfnClosePseudoConsole(hpc);
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
  Nan::SetMethod(target, "getProcessList", PtyGetProcessList);
};

NODE_MODULE(pty, init);
