/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 *
 * Ported to N-API by Matthew Denninghoff and David Russo
 * Reference: https://github.com/nodejs/node-addon-api
 *
 */

#include <napi.h>
#include <windows.h>

static Napi::Value ApiConsoleProcessList(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    Napi::Error::New(env, "Usage: getConsoleProcessList(shellPid)").ThrowAsJavaScriptException();

    return env.Undefined();
  }

  const SHORT pid = info[0].As<Napi::Number>().Uint32Value();

  if (!FreeConsole()) {
    Napi::Error::New(env, "FreeConsole failed").ThrowAsJavaScriptException();

  }
  if (!AttachConsole(pid)) {
    Napi::Error::New(env, "AttachConsole failed").ThrowAsJavaScriptException();

  }
  auto processList = std::vector<DWORD>(64);
  auto processCount = GetConsoleProcessList(&processList[0], processList.size());
  if (processList.size() < processCount) {
      processList.resize(processCount);
      processCount = GetConsoleProcessList(&processList[0], processList.size());
  }
  FreeConsole();

  Napi::Array result = Napi::Array::New(env);
  for (DWORD i = 0; i < processCount; i++) {
    (result).Set(i, Napi::Number::New(env, processList[i]));
  }
  return result;
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  exports.Set(Napi::String::New(env, "getConsoleProcessList"), Napi::Function::New(env, ApiConsoleProcessList));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
