/**
* pty.js
* Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
*
* pty.cc:
*   This file is responsible for starting processes
*   with pseudo-terminal file descriptors.
*/

#include "nan.h"

#include <string.h>
#include <stdlib.h>
#include <winpty.h>
#include <Shlwapi.h> // PathCombine
#include <string>
#include <sstream>
#include <iostream>
#include <vector>
#include <windows.h>

using namespace v8;
using namespace std;
using namespace node;

/**
* Misc
*/
extern "C" void init(Handle<Object>);

#define WINPTY_DBG_VARIABLE TEXT("WINPTYDBG")
#define MAX_ENV 65536

/**
* winpty
*/
static std::vector<winpty_t *> ptyHandles;
static volatile LONG ptyCounter;

struct winpty_s {
  winpty_s();
  HANDLE controlPipe;
  HANDLE coninPipeName;
  HANDLE conoutPipeName;
};

winpty_s::winpty_s() :
  controlPipe(nullptr),
  coninPipeName(nullptr),
  conoutPipeName(nullptr)
{
}

/**
* Helpers
*/

const wchar_t* to_wstring(const String::Utf8Value& str)
{
  const char *bytes = *str;
  unsigned int sizeOfStr = MultiByteToWideChar(CP_UTF8, 0, bytes, -1, NULL, 0);
  wchar_t *output = new wchar_t[sizeOfStr];
  MultiByteToWideChar(CP_UTF8, 0, bytes, -1, output, sizeOfStr);
  return output;
}

static winpty_t *get_pipe_handle(int handle) {
  for(size_t i = 0; i < ptyHandles.size(); ++i) {
    winpty_t *ptyHandle = ptyHandles[i];
    int current = (int)winpty_agent_process(ptyHandle);
    if(current == handle) {
      return ptyHandle;
    }
  }
  return nullptr;
}

static bool remove_pipe_handle(int handle) {
  for(size_t i = 0; i < ptyHandles.size(); ++i) {
    winpty_t *ptyHandle = ptyHandles[i];
    if((int)winpty_agent_process(ptyHandle) == handle) {
      delete ptyHandle;
      ptyHandle = nullptr;
      return true;
    }
  }
  return false;
}

static bool file_exists(std::wstring filename) {
  DWORD attr = ::GetFileAttributesW(filename.c_str());
  if(attr == INVALID_FILE_ATTRIBUTES || (attr & FILE_ATTRIBUTE_DIRECTORY)) {
    return false;
  }
  return true;
}

// cmd.exe -> C:\Windows\system32\cmd.exe
static std::wstring get_shell_path(std::wstring filename)  {

  std::wstring shellpath;

  if(file_exists(filename)) {
    return shellpath;
  }

  wchar_t buffer_[MAX_ENV];
  int read = ::GetEnvironmentVariableW(L"Path", buffer_, MAX_ENV);
  if(!read) {
    return shellpath;
  }

  std::wstring delimiter = L";";
  size_t pos = 0;
  vector<wstring> paths;
  std::wstring buffer(buffer_);
  while ((pos = buffer.find(delimiter)) != std::wstring::npos) {
    paths.push_back(buffer.substr(0, pos));
    buffer.erase(0, pos + delimiter.length());
  }

  const wchar_t *filename_ = filename.c_str();

  for (int i = 0; i < paths.size(); ++i) {
    wstring path = paths[i];
    wchar_t searchPath[MAX_PATH];
    ::PathCombineW(searchPath, const_cast<wchar_t*>(path.c_str()), filename_);

    if(searchPath == NULL) {
      continue;
    }

    if(file_exists(searchPath)) {
      shellpath = searchPath;
      break;
    }

  }

  return shellpath;
}

/*
* PtyOpen
* pty.open(dataPipe, cols, rows)
*
* If you need to debug winpty-agent.exe do the following:
* ======================================================
*
* 1) Install python 2.7
* 2) Install win32pipe
x86) http://sourceforge.net/projects/pywin32/files/pywin32/Build%20218/pywin32-218.win32-py2.7.exe/download
x64) http://sourceforge.net/projects/pywin32/files/pywin32/Build%20218/pywin32-218.win-amd64-py2.7.exe/download
* 3) Start deps/winpty/misc/DebugServer.py (Before you start node)
*
* Then you'll see output from winpty-agent.exe.
*
* Important part:
* ===============
* CreateProcess: success 8896 0 (Windows error code)
*
* Create test.js:
* ===============
*
* var pty = require('./');
*
* var term = pty.fork('cmd.exe', [], {
*   name: 'Windows Shell',
*	  cols: 80,
*	  rows: 30,
*	  cwd: process.env.HOME,
*	  env: process.env,
*	  debug: true
* });
*
* term.on('data', function(data) {
* 	console.log(data);
* });
*
*/

// static NAN_METHOD(PtyOpen) {
//   Nan::HandleScope scope;

//   if (info.Length() != 4
//     || !info[0]->IsString() // dataPipe
//     || !info[1]->IsNumber() // cols
//     || !info[2]->IsNumber() // rows
//     || !info[3]->IsBoolean()) // debug
//   {
//     return Nan::ThrowError("Usage: pty.open(dataPipe, cols, rows, debug)");
//   }

//   int cols = info[1]->Int32Value();
//   int rows = info[2]->Int32Value();
//   bool debug = info[3]->ToBoolean()->IsTrue();

//   // Enable/disable debugging
//   SetEnvironmentVariable(WINPTY_DBG_VARIABLE, debug ? "1" : NULL); // NULL = deletes variable

//   // Open a new pty session.
//   // winpty_t *pc = winpty_open(cols, rows);
//   winpty_t *pc = winpty_open(winpty_config_new(0, nullptr), nullptr);

//   // Error occured during startup of agent process.
//   assert(pc != nullptr);

//   assert(0 == winpty_set_size(pc, cols, rows, nullptr));

//   // Save pty struct fpr later use.
//   ptyHandles.insert(ptyHandles.end(), pc);

//   // Pty object values.
//   Local<Object> marshal = Nan::New<Object>();
//   marshal->Set(Nan::New<String>("pid").ToLocalChecked(), Nan::New<Number>((int)pc->controlPipe));
//   marshal->Set(Nan::New<String>("pty").ToLocalChecked(), Nan::New<Number>(InterlockedIncrement(&ptyCounter)));
//   marshal->Set(Nan::New<String>("fd").ToLocalChecked(), Nan::New<Number>(-1));

//   return info.GetReturnValue().Set(marshal);
// }

/*
* PtyStartProcess
* pty.startProcess(pid, file, env, cwd);
*/

static NAN_METHOD(PtyStartProcess) {
  Nan::HandleScope scope;

  if (info.Length() != 7
    || !info[0]->IsString() // file
    || !info[1]->IsString() // cmdline
    || !info[2]->IsArray() // env
    || !info[3]->IsString() // cwd
    || !info[4]->IsNumber() // cols
    || !info[5]->IsNumber() // rows
    || !info[6]->IsBoolean()) // debug
  {
    return Nan::ThrowError(
        "Usage: pty.startProcess(file, cmdline, env, cwd, cols, rows, debug)");
  }

  std::stringstream why;

  const wchar_t *filename = to_wstring(String::Utf8Value(info[0]->ToString()));
  const wchar_t *cmdline = to_wstring(String::Utf8Value(info[1]->ToString()));
  const wchar_t *cwd = to_wstring(String::Utf8Value(info[3]->ToString()));

  // create environment block
  wchar_t *env = NULL;
  const Handle<Array> envValues = Handle<Array>::Cast(info[2]);
  // if(!envValues.IsEmpty()) {

  //   std::wstringstream envBlock;

  //   for(uint32_t i = 0; i < envValues->Length(); i++) {
  //     std::wstring envValue(to_wstring(String::Utf8Value(envValues->Get(i)->ToString())));
  //     envBlock << envValue << L' ';
  //   }

  //   std::wstring output = envBlock.str();

  //   size_t count = output.size();
  //   env = new wchar_t[count + 2];
  //   wcsncpy(env, output.c_str(), count);

  //   wcscat(env, L"\0");
  // }

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if(::PathIsRelativeW(filename)) {
    shellpath = get_shell_path(filename);
  } else {
    shellpath = filename;
  }

  std::string shellpath_(shellpath.begin(), shellpath.end());

  if(shellpath.empty() || !file_exists(shellpath)) {
    goto invalid_filename;
  }

  goto open;

open:

  // Below used to be PtyOpen
  int cols = info[4]->Int32Value();
  int rows = info[5]->Int32Value();
  bool debug = info[6]->ToBoolean()->IsTrue();

  // Enable/disable debugging
  SetEnvironmentVariable(WINPTY_DBG_VARIABLE, debug ? "1" : NULL); // NULL = deletes variable

  // Open a new pty session.
  // winpty_t *pc = winpty_open(cols, rows);
  winpty_error_ptr_t error_ptr = nullptr;
  winpty_config_t* winpty_config = winpty_config_new(0, &error_ptr);
  if (winpty_config == nullptr) {
    std::wstring msg(winpty_error_msg(error_ptr));
    std::string msg_(msg.begin(), msg.end());
    why << "Error creating WinPTY config: " << msg_;
    Nan::ThrowError(why.str().c_str());
  }
  winpty_error_free(error_ptr);
  winpty_config_set_initial_size(winpty_config, cols, rows);

  // TODO: winpty_open throws the subscript error
  winpty_t *pc = winpty_open(winpty_config, &error_ptr);



  if (pc == nullptr) {
    std::wstring msg(winpty_error_msg(error_ptr));
    std::string msg_(msg.begin(), msg.end());
    why << "Error launching WinPTY agent: " << msg_;
    Nan::ThrowError(why.str().c_str());
  }
  //  if (pc->controlPipe == INVALID_HANDLE_VALUE) {
  //     why << "WinPTY controlPipe is invalid: " << GetLastError();
  //     Nan::ThrowError(why.str().c_str());
  //  }

  winpty_config_free(winpty_config);
  winpty_error_free(error_ptr);
  // why << "a: " << (int)pc->controlPipe;
  // Nan::ThrowError(why.str().c_str());

  // Save pty struct fpr later use.
  ptyHandles.insert(ptyHandles.end(), pc);
  //  HANDLE conin = CreateFileW(
  //      winpty_conin_name(pc),
  //      GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  //  HANDLE conout = CreateFileW(
  //      winpty_conout_name(pc),
  //      GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  //  assert(conin != INVALID_HANDLE_VALUE);
  //  assert(conout != INVALID_HANDLE_VALUE);

  winpty_spawn_config_t* config = winpty_spawn_config_new(WINPTY_SPAWN_FLAG_AUTO_SHUTDOWN, shellpath.c_str(), cmdline, cwd, nullptr/*env*/, nullptr);
  HANDLE handle = nullptr;
  BOOL spawnSuccess = winpty_spawn(pc, config, &handle, nullptr, nullptr, nullptr);
  winpty_spawn_config_free(config);
  if(!spawnSuccess) {
    why << "Unable to start terminal process.";
    Nan::ThrowError(why.str().c_str());
  }

  // Pty object values.
  Local<Object> marshal = Nan::New<Object>();
  
  marshal->Set(Nan::New<String>("pid").ToLocalChecked(), Nan::New<Number>((int)winpty_agent_process(pc)));
  marshal->Set(Nan::New<String>("pty").ToLocalChecked(), Nan::New<Number>(InterlockedIncrement(&ptyCounter)));
  marshal->Set(Nan::New<String>("fd").ToLocalChecked(), Nan::New<Number>(-1));



  //marshal->Set(Nan::New<String>("pid_agent").ToLocalChecked(), Nan::New<Number>((int)winpty_agent_process(pc)));



  {
    LPCWSTR coninPipeName = winpty_conin_name(pc);
    std::wstring coninPipeNameWStr(coninPipeName);
    std::string coninPipeNameStr(coninPipeNameWStr.begin(), coninPipeNameWStr.end());
    marshal->Set(Nan::New<String>("conin").ToLocalChecked(), Nan::New<String>(coninPipeNameStr).ToLocalChecked());
    LPCWSTR conoutPipeName = winpty_conout_name(pc);
    std::wstring conoutPipeNameWStr(conoutPipeName);
    std::string conoutPipeNameStr(conoutPipeNameWStr.begin(), conoutPipeNameWStr.end());
    marshal->Set(Nan::New<String>("conout").ToLocalChecked(), Nan::New<String>(conoutPipeNameStr).ToLocalChecked());
  }
  //CloseHandle(handle);

  goto cleanup;

invalid_filename:
  why << "File not found: " << shellpath_;
  Nan::ThrowError(why.str().c_str());
  goto cleanup;

cleanup:
  delete filename;
  delete cmdline;
  delete cwd;
  delete env;

  return info.GetReturnValue().Set(marshal);
  // return info.GetReturnValue().Set(handle);
}

/*
* PtyResize
* pty.resize(pid, cols, rows);
*/
static NAN_METHOD(PtyResize) {
  Nan::HandleScope scope;

  if (info.Length() != 3
    || !info[0]->IsNumber() // pid
    || !info[1]->IsNumber() // cols
    || !info[2]->IsNumber()) // rows
  {
    return Nan::ThrowError("Usage: pty.resize(pid, cols, rows)");
  }

  int handle = info[0]->Int32Value();
  int cols = info[1]->Int32Value();
  int rows = info[2]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);
  
  assert(pc != nullptr);
  BOOL success = winpty_set_size(pc, cols, rows, nullptr);
  assert(success);

  return info.GetReturnValue().SetUndefined();
}

/*
* PtyKill
* pty.kill(pid);
*/
static NAN_METHOD(PtyKill) {
  Nan::HandleScope scope;

  if (info.Length() != 1
    || !info[0]->IsNumber()) // pid
  {
    return Nan::ThrowError("Usage: pty.kill(pid)");
  }

  int handle = info[0]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);

  assert(pc != nullptr);
  // TODO: What should be called here in 0.4.0?
  //winpty_close(pc);
  assert(true == remove_pipe_handle(handle));

  return info.GetReturnValue().SetUndefined();
}

/**
* Init
*/

extern "C" void init(Handle<Object> target) {
  Nan::HandleScope scope;
  //Nan::SetMethod(target, "open", PtyOpen);
  Nan::SetMethod(target, "startProcess", PtyStartProcess);
  Nan::SetMethod(target, "resize", PtyResize);
  Nan::SetMethod(target, "kill", PtyKill);
};

NODE_MODULE(pty, init);
