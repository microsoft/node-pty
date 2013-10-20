/**
* pty.js
* Copyright (c) 2013, Christopher Jeffrey, Peter Sunde (MIT License)
*
* pty.cc:
*   This file is responsible for starting processes
*   with pseudo-terminal file descriptors.
*/

#include <v8.h>
#include <node.h>
#include <node_buffer.h>
#include <string.h>
#include <stdlib.h>
#include <winpty.h>
#include <Shlwapi.h> // PathCombine
#include <string>
#include <sstream>
#include <iostream>
#include <vector>

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
  HANDLE dataPipe;
};

winpty_s::winpty_s() : 
  controlPipe(nullptr), 
  dataPipe(nullptr)
{
}

/**
* Helpers
*/

const wchar_t* to_wstring(const String::Utf8Value& str)
{
  const char *bytes = *str;
  unsigned int sizeOfStr = MultiByteToWideChar(CP_ACP, 0, bytes, -1, NULL, 0);  
  wchar_t *output = new wchar_t[sizeOfStr];  	   
  MultiByteToWideChar(CP_ACP, 0, bytes, -1, output, sizeOfStr);  
  return output;
}

static winpty_t *get_pipe_handle(int handle) {
  for(winpty_t *ptyHandle : ptyHandles) {
    int current = (int)ptyHandle->controlPipe;
    if(current == handle) {
      return ptyHandle;
    }
  }
  return nullptr;
}

static bool remove_pipe_handle(int handle) {
  for(winpty_t *ptyHandle : ptyHandles) {
    if((int)ptyHandle->controlPipe == handle) {
      delete ptyHandle;
      ptyHandle = nullptr;
      return true;
    }
  }
  return false;
}

static bool file_exists(std::wstring filename) {
  return (INVALID_FILE_ATTRIBUTES == ::GetFileAttributesW(filename.c_str()) && 
    ::GetLastError() == ERROR_FILE_NOT_FOUND) == false;
}

// cmd.exe -> C:\Windows\system32\cmd.exe
static std::wstring get_shell_path(std::wstring filename)  {

  if(file_exists(filename)) {
    return nullptr;
  }

  wchar_t buffer_[MAX_ENV];
  int read = ::GetEnvironmentVariableW(L"Path", buffer_, MAX_ENV);
  if(!read) {
    return nullptr;
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

  for(wstring path : paths) {
    wchar_t pathCombined[MAX_PATH];   
    ::PathCombineW(pathCombined, const_cast<wchar_t*>(path.c_str()), filename_);

    if(pathCombined == NULL) {
      continue;
    }

    if(file_exists(pathCombined)) {
      return std::wstring(pathCombined);
    }

  }

  return nullptr;
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

static Handle<Value> PtyOpen(const Arguments& args) {
  HandleScope scope;

  if (args.Length() != 4
    || !args[0]->IsString() // dataPipe
    || !args[1]->IsNumber() // cols
    || !args[2]->IsNumber() // rows
    || !args[3]->IsBoolean()) // debug
  {
    return ThrowException(Exception::Error(
      String::New("Usage: pty.open(dataPipe, cols, rows, debug)")));
  }

  const wchar_t *pipeName = to_wstring(String::Utf8Value(args[0]->ToString()));
  int cols = args[1]->Int32Value();
  int rows = args[2]->Int32Value();
  bool debug = args[3]->ToBoolean()->IsTrue();

  // Enable/disable debugging
  SetEnvironmentVariable(WINPTY_DBG_VARIABLE, debug ? "1" : NULL); // NULL = deletes variable

  // Open a new pty session.
  winpty_t *pc = winpty_open_use_own_datapipe(pipeName, cols, rows);

  // Error occured during startup of agent process.
  assert(pc != nullptr);

  // Save pty struct fpr later use.
  ptyHandles.insert(ptyHandles.end(), pc);

  // Pty object values.
  Local<Object> marshal = Object::New();
  marshal->Set(String::New("pid"), Number::New((int)pc->controlPipe));
  marshal->Set(String::New("pty"), Number::New(InterlockedIncrement(&ptyCounter)));
  marshal->Set(String::New("fd"), Number::New(-1));

  delete pipeName;

  return scope.Close(marshal);

}

/*
* PtyStartProcess
* pty.startProcess(pid, file, env, cwd);
*/

static Handle<Value> PtyStartProcess(const Arguments& args) {
  HandleScope scope;

  if (args.Length() != 5
    || !args[0]->IsNumber() // pid
    || !args[1]->IsString() // file
    || !args[2]->IsString() // cmdline
    || !args[3]->IsArray() // env
    || !args[4]->IsString()) // cwd
  {
    return ThrowException(Exception::Error(
      String::New("Usage: pty.startProcess(pid, file, cmdline, env, cwd)")));
  }

  // Get winpty_t by control pipe handle
  int pid = args[0]->Int32Value();

  winpty_t *pc = get_pipe_handle(pid);
  assert(pc != nullptr);

  const wchar_t *filename = to_wstring(String::Utf8Value(args[1]->ToString()));
  const wchar_t *cmdline = to_wstring(String::Utf8Value(args[2]->ToString()));
  const wchar_t *cwd = to_wstring(String::Utf8Value(args[4]->ToString()));

  // create environment block
  wchar_t *env = NULL;
  const Handle<Array> envValues = Handle<Array>::Cast(args[3]);
  if(!envValues.IsEmpty()) {

    std::wstringstream envBlock;

    for(uint32_t i = 0; i < envValues->Length(); i++) {
      std::wstring envValue(to_wstring(String::Utf8Value(envValues->Get(i)->ToString())));
      envBlock << envValue << L' ';
    }

    std::wstring output = envBlock.str();

    size_t count = output.size();
    env = new wchar_t[count + 2];
    wcsncpy(env, output.c_str(), count);

    wcscat(env, L"\0");
  }

  // use environment 'Path' variable to determine location of 
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if(::PathIsRelativeW(filename)) {
    shellpath = get_shell_path(filename);
  } else {
    shellpath = filename;
  }

  if(!file_exists(shellpath)) {
    return ThrowException(Exception::Error(String::New("Unable to load executable, it does not exist.")));
  }

  int result = winpty_start_process(pc, shellpath.c_str(), cmdline, cwd, env);
  delete env;
  assert(0 == result);

  return scope.Close(Undefined());
}

/*
* PtyResize
* pty.resize(pid, cols, rows);
*/
static Handle<Value> PtyResize(const Arguments& args) {
  HandleScope scope;

  if (args.Length() != 3
    || !args[0]->IsNumber() // pid
    || !args[1]->IsNumber() // cols
    || !args[2]->IsNumber()) // rows
  {
    return ThrowException(Exception::Error(String::New("Usage: pty.resize(pid, cols, rows)")));
  }

  int handle = args[0]->Int32Value();
  int cols = args[1]->Int32Value();
  int rows = args[2]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);

  assert(pc != nullptr);
  assert(0 == winpty_set_size(pc, cols, rows));

  return scope.Close(Undefined());
}

/*
* PtyKill
* pty.kill(pid);
*/
static Handle<Value> PtyKill(const Arguments& args) {
  HandleScope scope;

  if (args.Length() != 1
    || !args[0]->IsNumber()) // pid
  {
    return ThrowException(Exception::Error(String::New("Usage: pty.kill(pid)")));
  }

  int handle = args[0]->Int32Value();

  winpty_t *pc = get_pipe_handle(handle);

  assert(pc != nullptr);
  winpty_exit(pc);
  assert(true == remove_pipe_handle(handle));

  return scope.Close(Undefined());

}

/**
* Init
*/

extern "C" void init(Handle<Object> target) {
  HandleScope scope;
  NODE_SET_METHOD(target, "open", PtyOpen);
  NODE_SET_METHOD(target, "startProcess", PtyStartProcess);
  NODE_SET_METHOD(target, "resize", PtyResize);
  NODE_SET_METHOD(target, "kill", PtyKill);
};

NODE_MODULE(pty, init);
