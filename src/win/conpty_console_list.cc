/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 */
#include <iostream>
#include <napi.h>
#include <ostream>

#ifdef _WIN32
    // Windows 平台
  #define NODE_ADDON_API_DISABLE_DEPRECATED
  #include <windows.h>
  #include <tlhelp32.h>
  #include <stdio.h>
  void ListChildProcesses(DWORD pid,std::vector<DWORD> &children_clist) {
    PROCESSENTRY32 pe32;
    HANDLE hProcessSnap;
    // 设置 PROCESSENTRY32 结构体的大小
    pe32.dwSize = sizeof(PROCESSENTRY32);
    // 创建进程快照
    hProcessSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hProcessSnap == INVALID_HANDLE_VALUE) {
      return;
    }
    // 遍历所有进程
    if (Process32First(hProcessSnap, &pe32)) {
      do {
        // 如果该进程的父进程 ID (PPID) 是指定的 PID，则认为它是子进程
        if (pe32.th32ParentProcessID == pid) {
          children_clist.push_back(pe32.th32ProcessID);
        }
      } while (Process32Next(hProcessSnap, &pe32));  // 继续遍历下一个进程
    }
    // 关闭快照句柄
    CloseHandle(hProcessSnap);
  }
#elif defined(__linux__)
    #include <vector>
    #include <dirent.h>
    #include <fstream>
    #include <sstream>
    #include <string>
    #include <iostream>
    // Linux 平台
    void ListChildProcesses(pid_t pid, std::vector<pid_t>& children_clist) {
    DIR* dir = opendir("/proc");
    if (dir == nullptr) {
      std::cerr << "Failed to open /proc directory" << std::endl;
      return;
    }
    struct dirent* entry;
    while ((entry = readdir(dir)) != nullptr) {
      // 跳过非数字目录
      if (!isdigit(entry->d_name[0])) {
        continue;
      }
      pid_t current_pid = std::stoi(entry->d_name); // 当前进程 PID
      // 打开该进程的 stat 文件，获取父进程 PID (PPID)
      std::string stat_path = std::string("/proc/") + entry->d_name + "/stat";
      std::ifstream stat_file(stat_path);
      if (stat_file.is_open()) {
        std::string line;
        std::getline(stat_file, line);
        std::istringstream ss(line);

        pid_t ppid;
        ss >> current_pid;  // 当前进程 PID
        ss.ignore(256, ' '); // 跳过进程名称部分
        ss >> ppid;          // 获取父进程 PID
        if (ppid == pid) {
          // 如果父进程 PID 匹配，则将当前进程的 PID 添加到子进程列表
          children_clist.push_back(current_pid);
        }
      }
    }
    closedir(dir);  // 关闭 /proc 目录
  }
#elif defined(__APPLE__) && defined(__MACH__)
    // macOS 平台
    #include <iostream>
    #include <vector>
    #include <sys/types.h>
    #include <dirent.h>
    #include <unistd.h>
    #include <sys/proc_info.h>
    #include <sys/sysctl.h>
    #include <cstring>
  // 获取进程的父进程 PID
  pid_t GetParentPid(pid_t pid) {
    struct proc_bsdinfo info;
    size_t len = sizeof(info);
    int ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, len);

    if (ret < 0) {
      std::cerr << "Failed to get parent PID for " << pid << std::endl;
      return -1;
    }

    return info.pbi_ppid;  // 返回父进程 PID
  }

  // 获取指定进程的所有子进程
  void ListChildProcesses(pid_t pid, std::vector<pid_t>& children_clist) {
    DIR* dir = opendir("/proc");
    if (dir == nullptr) {
      std::cerr << "Failed to open /proc directory" << std::endl;
      return;
    }
    struct dirent* entry;
    while ((entry = readdir(dir)) != nullptr) {
      // 跳过非数字目录
      if (!isdigit(entry->d_name[0])) {
        continue;
      }
      pid_t current_pid = std::stoi(entry->d_name);  // 当前进程 PID
      // 获取当前进程的父进程 PID
      pid_t ppid = GetParentPid(current_pid);
      if (ppid == pid) {
        // 如果父进程 PID 匹配，则将当前进程的 PID 添加到子进程列表
        children_clist.push_back(current_pid);
      }
    }
    closedir(dir);  // 关闭 /proc 目录
  }
#else
    // 不支持的平台
#endif

static Napi::Promise  ApiConsoleProcessList(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  if (info.Length() != 1 ||
      !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: getConsoleProcessList(shellPid)");
  }

  const DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  // 创建一个 Promise 对象
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
      // 创建一个线程安全的函数，用于在主线程上执行
      Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
      env,
      Napi::Function::New(env, [deferred](const Napi::CallbackInfo& info) {
          auto list = info[0].As<Napi::Array>();
          deferred.Resolve(list);
          // return Napi::Object::New(info.Env());
      }),
      "ThreadSafeFunction",
      0,  // no maximum queue size
      1   // only one worker thread
  );
  std::thread([pid,tsfn]()  {
          auto processList = std::vector<DWORD>(0);
          ListChildProcesses(pid,processList);
          tsfn.BlockingCall([processList](Napi::Env env, Napi::Function jsCallback)
                          {
                            Napi::Array result = Napi::Array::New(env);
                            for (DWORD i = 0; i < processList.size(); i++) {
                             result.Set(i, Napi::Number::New(env, processList[i]));
                            }
                            jsCallback.Call({result});
                          });
          tsfn.Release();
    }).detach(); // 分离线程，这样线程会在后台运行
  return deferred.Promise();
}

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("getConsoleProcessList", Napi::Function::New(env, ApiConsoleProcessList));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
