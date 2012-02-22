/**
 * pty.cc
 * This file is responsible for starting processes
 * with pseudo-terminal file descriptors.
 *
 * man pty
 * man tty_ioctl
 * man tcsetattr
 * man forkpty
 */

#include <v8.h>
#include <node.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <fcntl.h>

/* forkpty */
/* http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html */
#if defined(__GLIBC__) || defined(__CYGWIN__)
  #include <pty.h>
#elif defined(__APPLE__) || defined(__OpenBSD__) || defined(__NetBSD__)
  #include <util.h>
#elif defined(__FreeBSD__)
  #include <libutil.h>
#else
  #include <pty.h>
#endif

#include <utmp.h> /* login_tty */
#include <termios.h> /* tcgetattr, tty_ioctl */

// environ for execvpe
#ifdef __APPLE__
  #include <crt_externs.h>
  #define environ (*_NSGetEnviron())
#else
extern char **environ;
#endif

using namespace std;
using namespace node;
using namespace v8;

static Handle<Value> PtyFork(const Arguments&);
static Handle<Value> PtyResize(const Arguments&);
static int pty_execvpe(const char *file, char **argv, char **envp);
static int pty_nonblock(int fd);
extern "C" void init(Handle<Object>);

static Handle<Value> PtyFork(const Arguments& args) {
  HandleScope scope;

  if (args.Length() < 6) {
    return ThrowException(Exception::Error(
      String::New("Not enough arguments.")));
  }

  if (!args[0]->IsString()) {
    return ThrowException(Exception::Error(
      String::New("file must be a string.")));
  }

  if (!args[1]->IsArray()) {
    return ThrowException(Exception::Error(
      String::New("args must be an array.")));
  }

  if (!args[2]->IsArray()) {
    return ThrowException(Exception::Error(
      String::New("env must be an array.")));
  }

  if (!args[3]->IsString()) {
    return ThrowException(Exception::Error(
      String::New("cwd must be a string.")));
  }

  if (!args[4]->IsNumber() || !args[5]->IsNumber()) {
    return ThrowException(Exception::Error(
      String::New("cols and rows must be numbers.")));
  }

  // node/src/node_child_process.cc

  // file
  String::Utf8Value file(args[0]->ToString());

  // args
  int i = 0;
  Local<Array> argv_ = Local<Array>::Cast(args[1]);
  int argc = argv_->Length();
  int argl = argc + 1 + 1;
  char **argv = new char*[argl];
  argv[0] = strdup(*file);
  argv[argl-1] = NULL;
  for (; i < argc; i++) {
    String::Utf8Value arg(argv_->Get(Integer::New(i))->ToString());
    argv[i+1] = strdup(*arg);
  }

  // env
  i = 0;
  Local<Array> env_ = Local<Array>::Cast(args[2]);
  int envc = env_->Length();
  char **env = new char*[envc+1];
  env[envc] = NULL;
  for (; i < envc; i++) {
    String::Utf8Value pair(env_->Get(Integer::New(i))->ToString());
    env[i] = strdup(*pair);
  }

  // cwd
  String::Utf8Value cwd_(args[3]->ToString());
  char *cwd = strdup(*cwd_);

  // size
  struct winsize winp = {};
  Local<Integer> cols = args[4]->ToInteger();
  Local<Integer> rows = args[5]->ToInteger();
  winp.ws_col = cols->Value();
  winp.ws_row = rows->Value();

  // fork the pty
  int master;
  char name[40];
  pid_t pid = forkpty(&master, name, NULL, &winp);

  switch (pid) {
    case -1:
      return ThrowException(Exception::Error(
        String::New("forkpty failed.")));
    case 0:
      if (strlen(cwd)) chdir(cwd);

      pty_execvpe(argv[0], argv, env);

      perror("execvp failed");
      _exit(1);
    default:
      // cleanup
      for (i = 0; i < argl; i++) free(argv[i]);
      delete[] argv;

      for (i = 0; i < envc; i++) free(env[i]);
      delete[] env;

      free(cwd);

      // nonblocking
      if (pty_nonblock(master) == -1) {
        return ThrowException(Exception::Error(
          String::New("Could not set master fd to nonblocking.")));
      }

      Local<Object> obj = Object::New();
      obj->Set(String::New("fd"), Number::New(master));
      obj->Set(String::New("pid"), Number::New(pid));
      obj->Set(String::New("pty"), String::New(name));

      return scope.Close(obj);
  }

  return Undefined();
}

/**
 * Expose Resize Functionality
 */

static Handle<Value> PtyResize(const Arguments& args) {
  HandleScope scope;

  if (args.Length() > 0 && !args[0]->IsNumber()) {
    return ThrowException(Exception::Error(
      String::New("First argument must be a number.")));
  }

  struct winsize winp = {};
  winp.ws_col = 80;
  winp.ws_row = 30;

  int fd = args[0]->ToInteger()->Value();

  if (args.Length() == 3) {
    if (args[1]->IsNumber() && args[2]->IsNumber()) {
      Local<Integer> cols = args[1]->ToInteger();
      Local<Integer> rows = args[2]->ToInteger();

      winp.ws_col = cols->Value();
      winp.ws_row = rows->Value();
    } else {
      return ThrowException(Exception::Error(
        String::New("cols and rows need to be numbers.")));
    }
  }

  if (ioctl(fd, TIOCSWINSZ, &winp) == -1) {
    return ThrowException(Exception::Error(
      String::New("ioctl failed.")));
  }

  return Undefined();
}

/**
 * execvpe
 */

// execvpe(3) is not portable.
// http://www.gnu.org/software/gnulib/manual/html_node/execvpe.html

static int pty_execvpe(const char *file, char **argv, char **envp) {
  char **old = environ;
  environ = envp;
  int ret = execvp(file, argv);
  environ = old;
  return ret;
}

/**
 * FD to nonblocking
 */

static int pty_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/**
 * Init
 */

extern "C" void init(Handle<Object> target) {
  HandleScope scope;
  NODE_SET_METHOD(target, "fork", PtyFork);
  NODE_SET_METHOD(target, "resize", PtyResize);
}
