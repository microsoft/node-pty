/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 *
 * Ported to N-API by Matthew Denninghoff and David Russo
 * Reference: https://github.com/nodejs/node-addon-api
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 */

#include <assert.h>
#include <iostream>
#include <napi.h>
#include <Shlwapi.h> // PathCombine, PathIsRelative
#include <sstream>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <winpty.h>

#include "path_util.h"

/**
* Misc
*/
extern "C" void init(Napi::Object);

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

void throw_winpty_error(const char *generalMsg, winpty_error_ptr_t error_ptr, Napi::Env env) {
  std::stringstream why;
  std::wstring msg(winpty_error_msg(error_ptr));
  std::string msg_(msg.begin(), msg.end());
  why << generalMsg << ": " << msg_;
  Napi::Error::New(env, why.str().c_str()).ThrowAsJavaScriptException();

  winpty_error_free(error_ptr);
}

static Napi::Value PtyGetExitCode(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.getExitCode(pidHandle)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  DWORD exitCode = 0;
  GetExitCodeProcess((HANDLE)info[0].As<Napi::Number>().Int32Value(), &exitCode);

  return Napi::Number::New(env, exitCode);
}

static Napi::Value PtyGetProcessList(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.getProcessList(pid)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  int pid = info[0].As<Napi::Number>().Int32Value();

  winpty_t *pc = get_pipe_handle(pid);
  if (pc == nullptr) {
    return Napi::Array::New(env, 0);
  }
  int processList[64];
  const int processCount = 64;
  int actualCount = winpty_get_console_process_list(pc, processList, processCount, nullptr);

  Napi::Array result = Napi::Array::New(env, actualCount);
  for (uint32_t i = 0; i < actualCount; i++) {
    (result).Set(i, Napi::Number::New(env, processList[i]));
  }
  return result;
}

static Napi::Value PtyStartProcess(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 7 ||
      !info[0].IsString() ||
      !info[1].IsString() ||
      !info[2].IsArray() ||
      !info[3].IsString() ||
      !info[4].IsNumber() ||
      !info[5].IsNumber() ||
      !info[6].IsBoolean()) {
    Napi::Error::New(env, "Usage: pty.startProcess(file, cmdline, env, cwd, cols, rows, debug)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  std::stringstream why;

  std::wstring filename(path_util::to_wstring(info[0].As<Napi::String>()));
  std::wstring cmdline(path_util::to_wstring(info[1].As<Napi::String>()));
  std::wstring cwd(path_util::to_wstring(info[3].As<Napi::String>()));

  // create environment block
  std::wstring envStr;
  const Napi::Array envValues = info[2].As<Napi::Array>();
  if (!envValues.IsEmpty()) {

    std::wstringstream envBlock;

    for(uint32_t i = 0; i < envValues.Length(); i++) {
      std::wstring envValue(path_util::to_wstring(envValues.Get(i).As<Napi::String>()));
      envBlock << envValue << L'\0';
    }

    envStr = envBlock.str();
  }

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if (::PathIsRelativeW(filename.c_str())) {
    shellpath = path_util::get_shell_path(filename);
  } else {
    shellpath = filename;
  }

  std::string shellpath_(shellpath.begin(), shellpath.end());

  if (shellpath.empty() || !path_util::file_exists(shellpath)) {
    why << "File not found: " << shellpath_;
    Napi::Error::New(env, why.str().c_str()).ThrowAsJavaScriptException();
  }

  int cols = info[4].As<Napi::Number>().Int32Value();
  int rows = info[5].As<Napi::Number>().Int32Value();
  bool debug = info[6].As<Napi::Boolean>().Value();

  // Enable/disable debugging
  SetEnvironmentVariable(WINPTY_DBG_VARIABLE, debug ? "1" : NULL); // NULL = deletes variable

  // Create winpty config
  winpty_error_ptr_t error_ptr = nullptr;
  winpty_config_t* winpty_config = winpty_config_new(0, &error_ptr);
  if (winpty_config == nullptr) {
    throw_winpty_error("Error creating WinPTY config", error_ptr, env);
  }
  winpty_error_free(error_ptr);

  // Set pty size on config
  winpty_config_set_initial_size(winpty_config, cols, rows);

  // Start the pty agent
  winpty_t *pc = winpty_open(winpty_config, &error_ptr);
  winpty_config_free(winpty_config);
  if (pc == nullptr) {
    throw_winpty_error("Error launching WinPTY agent", error_ptr, env);
  }
  winpty_error_free(error_ptr);

  // Save pty struct for later use
  ptyHandles.insert(ptyHandles.end(), pc);

  // Create winpty spawn config
  winpty_spawn_config_t* config = winpty_spawn_config_new(WINPTY_SPAWN_FLAG_AUTO_SHUTDOWN, shellpath.c_str(), cmdline.c_str(), cwd.c_str(), envStr.c_str(), &error_ptr);
  if (config == nullptr) {
    throw_winpty_error("Error creating WinPTY spawn config", error_ptr, env);
  }
  winpty_error_free(error_ptr);

  // Spawn the new process
  HANDLE handle = nullptr;
  BOOL spawnSuccess = winpty_spawn(pc, config, &handle, nullptr, nullptr, &error_ptr);
  winpty_spawn_config_free(config);
  if (!spawnSuccess) {
    throw_winpty_error("Unable to start terminal process", error_ptr, env);
  }
  winpty_error_free(error_ptr);

  // Set return values
  Napi::Object marshal = Napi::Object::New(env);
  (marshal).Set(Napi::String::New(env, "innerPid"), Napi::Number::New(env, (int)GetProcessId(handle)));
  (marshal).Set(Napi::String::New(env, "innerPidHandle"), Napi::Number::New(env, (int)handle));
  (marshal).Set(Napi::String::New(env, "pid"), Napi::Number::New(env, (int)winpty_agent_process(pc)));
  (marshal).Set(Napi::String::New(env, "pty"), Napi::Number::New(env, InterlockedIncrement(&ptyCounter)));
  (marshal).Set(Napi::String::New(env, "fd"), Napi::Number::New(env, -1));
  {
    LPCWSTR coninPipeName = winpty_conin_name(pc);
    std::wstring coninPipeNameWStr(coninPipeName);
    std::string coninPipeNameStr(coninPipeNameWStr.begin(), coninPipeNameWStr.end());
    (marshal).Set(Napi::String::New(env, "conin"), Napi::String::New(env, coninPipeNameStr));
    LPCWSTR conoutPipeName = winpty_conout_name(pc);
    std::wstring conoutPipeNameWStr(conoutPipeName);
    std::string conoutPipeNameStr(conoutPipeNameWStr.begin(), conoutPipeNameWStr.end());
    (marshal).Set(Napi::String::New(env, "conout"), Napi::String::New(env, conoutPipeNameStr));
  }
  return marshal;
}

static Napi::Value PtyResize(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 3 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.resize(pid, cols, rows)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  int cols = info[1].As<Napi::Number>().Int32Value();
  int rows = info[2].As<Napi::Number>().Int32Value();

  winpty_t *pc = get_pipe_handle(handle);

  if (pc == nullptr) {
    Napi::Error::New(env, "The pty doesn't appear to exist").ThrowAsJavaScriptException();

    return env.Undefined();
  }
  BOOL success = winpty_set_size(pc, cols, rows, nullptr);
  if (!success) {
    Napi::Error::New(env, "The pty could not be resized").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  return env.Undefined();
}

static Napi::Value PtyKill(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.kill(pid, innerPidHandle)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  HANDLE innerPidHandle = (HANDLE)info[1].As<Napi::Number>().Int32Value();

  winpty_t *pc = get_pipe_handle(handle);
  if (pc == nullptr) {
    Napi::Error::New(env, "Pty seems to have been killed already").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  assert(remove_pipe_handle(handle));
  CloseHandle(innerPidHandle);

  return env.Undefined();
}

/**
* Init
*/

Napi::Object init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  exports.Set(Napi::String::New(env, "startProcess"), Napi::Function::New(env, PtyStartProcess));
  exports.Set(Napi::String::New(env, "resize"), Napi::Function::New(env, PtyResize));
  exports.Set(Napi::String::New(env, "kill"), Napi::Function::New(env, PtyKill));
  exports.Set(Napi::String::New(env, "getExitCode"), Napi::Function::New(env, PtyGetExitCode));
  exports.Set(Napi::String::New(env, "getProcessList"), Napi::Function::New(env, PtyGetProcessList));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
