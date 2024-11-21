/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 */

#define NODE_ADDON_API_DISABLE_DEPRECATED
#include <napi.h>
#include <windows.h>

static Napi::Promise  ApiConsoleProcessList(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: getConsoleProcessList(shellPid)");
  }

  const DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  // 创建一个 Promise 对象
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  if (!FreeConsole()) {
            deferred.Reject(Napi::String::New(deferred.Env(),"FreeConsole failed"));
  }
  if (!AttachConsole(pid)) { // todo 这都是操当前的，不太行
            deferred.Reject(Napi::String::New(deferred.Env(),"AttachConsole failed"));
  }
  std::thread([pid,deferred]() mutable {
        // 执行耗时任务
        try {


          auto processList = std::vector<DWORD>(64);
          auto processCount = GetConsoleProcessList(&processList[0], static_cast<DWORD>(processList.size()));
          if (processList.size() < processCount) {
             processList.resize(processCount);
             processCount = GetConsoleProcessList(&processList[0], static_cast<DWORD>(processList.size()));
          }
          FreeConsole();
          Napi::Array result = Napi::Array::New(deferred.Env());
          for (DWORD i = 0; i < processCount; i++) {
           result.Set(i, Napi::Number::New(deferred.Env(), processList[i]));
          }
          deferred.Resolve(result);
        } catch (const std::exception& e) {
            deferred.Reject(Napi::String::New(deferred.Env(), e.what()));
        }
    }).detach(); // 分离线程，这样线程会在后台运行
  return deferred.Promise();
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("getConsoleProcessList", Napi::Function::New(env, ApiConsoleProcessList));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
