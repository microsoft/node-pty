/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2017, Daniel Imms (MIT License)
 *
 * Ported to N-API by Matthew Denninghoff and David Russo
 * Reference: https://github.com/nodejs/node-addon-api
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 *
 * See:
 *   man pty
 *   man tty_ioctl
 *   man termios
 *   man forkpty
 */

/**
 * Includes
 */

#include <assert.h>
#include <napi.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>

/* forkpty */
/* http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html */
#if defined(__GLIBC__) || defined(__CYGWIN__)
#include <pty.h>
#elif defined(__APPLE__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <util.h>
#elif defined(__FreeBSD__)
#include <libutil.h>
#elif defined(__sun)
#include <stropts.h> /* for I_PUSH */
#else
#include <pty.h>
#endif

#include <termios.h> /* tcgetattr, tty_ioctl */

/* Some platforms name VWERASE and VDISCARD differently */
#if !defined(VWERASE) && defined(VWERSE)
#define VWERASE	VWERSE
#endif
#if !defined(VDISCARD) && defined(VDISCRD)
#define VDISCARD	VDISCRD
#endif

/* environ for execvpe */
/* node/src/node_child_process.cc */
#if defined(__APPLE__) && !TARGET_OS_IPHONE
#include <crt_externs.h>
#define environ (*_NSGetEnviron())
#else
extern char **environ;
#endif

/* for pty_getproc */
#if defined(__linux__)
#include <stdio.h>
#include <stdint.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#include <libproc.h>
#endif

/* NSIG - macro for highest signal + 1, should be defined */
#ifndef NSIG
#define NSIG 32
#endif

// This class waits in another thread for the process to complete.
// When the process completes, the exit callback is run in the main thread.
class WaitForExit : public Napi::AsyncWorker {

  public:

    WaitForExit(Napi::Function& callback, pid_t pid)
    : Napi::AsyncWorker(callback), pid(pid) {}

    // The instance is destroyed automatically once OnOK or OnError method runs.
    // It deletes itself using the delete operator.
    ~WaitForExit() {}

    // This method runs in a worker thread.
    // It's invoked automatically after base class Queue method is called.
    void Execute() override {

      int ret;
      int stat_loc;

      errno = 0;

      if ((ret = waitpid(pid, &stat_loc, 0)) != pid) {
        if (ret == -1 && errno == EINTR) {
          return Execute();
        }
        if (ret == -1 && errno == ECHILD) {
          // XXX node v0.8.x seems to have this problem.
          // waitpid is already handled elsewhere.
          ;
        } else {
          assert(false);
        }
      }

      if (WIFEXITED(stat_loc)) {
        exit_code = WEXITSTATUS(stat_loc); // errno?
      }

      if (WIFSIGNALED(stat_loc)) {
        signal_code = WTERMSIG(stat_loc);
      }

    }

    // This method is run in the main thread after the Execute method completes.
    void OnOK() override {

      // Run callback and pass process exit code.
      Napi::HandleScope scope(Env());
      Callback().Call({
        Napi::Number::New(Env(), exit_code),
        Napi::Number::New(Env(), signal_code)
      });

    }

  private:

    pid_t pid;
    int exit_code;
    int signal_code;

};

/**
 * Methods
 */

Napi::Value PtyFork(const Napi::CallbackInfo& info);
Napi::Value PtyOpen(const Napi::CallbackInfo& info);
Napi::Value PtyResize(const Napi::CallbackInfo& info);
Napi::Value PtyGetProc(const Napi::CallbackInfo& info);

/**
 * Functions
 */

static int
pty_execvpe(const char *, char **, char **);

static int
pty_nonblock(int);

static char *
pty_getproc(int, char *);

static int
pty_openpty(int *, int *, char *,
            const struct termios *,
            const struct winsize *);

static pid_t
pty_forkpty(int *, char *,
            const struct termios *,
            const struct winsize *);

Napi::Value PtyFork(const Napi::CallbackInfo& info) {
  Napi::Env napiEnv(info.Env());
  Napi::HandleScope scope(napiEnv);

  if (info.Length() != 10 ||
      !info[0].IsString() ||
      !info[1].IsArray() ||
      !info[2].IsArray() ||
      !info[3].IsString() ||
      !info[4].IsNumber() ||
      !info[5].IsNumber() ||
      !info[6].IsNumber() ||
      !info[7].IsNumber() ||
      !info[8].IsBoolean() ||
      !info[9].IsFunction()) {
    Napi::Error::New(napiEnv, "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, utf8, onexit)").ThrowAsJavaScriptException();
    return napiEnv.Undefined();
  }

  // file
  std::string file = info[0].As<Napi::String>();

  // args
  int i = 0;
  Napi::Array argv_ = info[1].As<Napi::Array>();
  int argc = argv_.Length();
  int argl = argc + 1 + 1;
  char **argv = new char*[argl];
  argv[0] = strdup(file.c_str());
  argv[argl-1] = NULL;
  for (; i < argc; i++) {
    std::string arg = argv_.Get(i).As<Napi::String>();
    argv[i+1] = strdup(arg.c_str());
  }

  // env
  i = 0;
  Napi::Array env_ = info[2].As<Napi::Array>();
  int envc = env_.Length();
  char **env = new char*[envc+1];
  env[envc] = NULL;
  for (; i < envc; i++) {
    std::string pair = env_.Get(i).As<Napi::String>();
    env[i] = strdup(pair.c_str());
  }

  // cwd
  std::string cwd_ = info[3].As<Napi::String>();
  char *cwd = strdup(cwd_.c_str());

  // size
  struct winsize winp;
  winp.ws_col = info[4].As<Napi::Number>().Int32Value();
  winp.ws_row = info[5].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // termios
  struct termios t = termios();
  struct termios *term = &t;
  term->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT;
  if (info[8].As<Napi::Boolean>().Value()) {
#if defined(IUTF8)
    term->c_iflag |= IUTF8;
#endif
  }
  term->c_oflag = OPOST | ONLCR;
  term->c_cflag = CREAD | CS8 | HUPCL;
  term->c_lflag = ICANON | ISIG | IEXTEN | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL;

  term->c_cc[VEOF] = 4;
  term->c_cc[VEOL] = -1;
  term->c_cc[VEOL2] = -1;
  term->c_cc[VERASE] = 0x7f;
  term->c_cc[VWERASE] = 23;
  term->c_cc[VKILL] = 21;
  term->c_cc[VREPRINT] = 18;
  term->c_cc[VINTR] = 3;
  term->c_cc[VQUIT] = 0x1c;
  term->c_cc[VSUSP] = 26;
  term->c_cc[VSTART] = 17;
  term->c_cc[VSTOP] = 19;
  term->c_cc[VLNEXT] = 22;
  term->c_cc[VDISCARD] = 15;
  term->c_cc[VMIN] = 1;
  term->c_cc[VTIME] = 0;

  #if (__APPLE__)
  term->c_cc[VDSUSP] = 25;
  term->c_cc[VSTATUS] = 20;
  #endif

  cfsetispeed(term, B38400);
  cfsetospeed(term, B38400);

  // uid / gid
  int uid = info[6].As<Napi::Number>().Int32Value();
  int gid = info[7].As<Napi::Number>().Int32Value();

  // fork the pty
  int master = -1;

  sigset_t newmask, oldmask;
  struct sigaction sig_action;

  // temporarily block all signals
  // this is needed due to a race condition in openpty
  // and to avoid running signal handlers in the child
  // before exec* happened
  sigfillset(&newmask);
  pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);

  pid_t pid = pty_forkpty(&master, nullptr, term, &winp);

  if (!pid) {
    // remove all signal handler from child
    sig_action.sa_handler = SIG_DFL;
    sig_action.sa_flags = 0;
    sigemptyset(&sig_action.sa_mask);
    for (int i = 0 ; i < NSIG ; i++) {    // NSIG is a macro for all signals + 1
      sigaction(i, &sig_action, NULL);
    }
  }
  // reenable signals
  pthread_sigmask(SIG_SETMASK, &oldmask, NULL);

  if (pid) {
    for (i = 0; i < argl; i++) free(argv[i]);
    delete[] argv;
    for (i = 0; i < envc; i++) free(env[i]);
    delete[] env;
    free(cwd);
  }

  switch (pid) {
    case -1:
      Napi::Error::New(napiEnv, "forkpty(3) failed.").ThrowAsJavaScriptException();
      return napiEnv.Null();
    case 0:
      if (strlen(cwd)) {
        if (chdir(cwd) == -1) {
          perror("chdir(2) failed.");
          _exit(1);
        }
      }

      if (uid != -1 && gid != -1) {
        if (setgid(gid) == -1) {
          perror("setgid(2) failed.");
          _exit(1);
        }
        if (setuid(uid) == -1) {
          perror("setuid(2) failed.");
          _exit(1);
        }
      }

      pty_execvpe(argv[0], argv, env);

      perror("execvp(3) failed.");
      _exit(1);
    default:
      if (pty_nonblock(master) == -1) {
        Napi::Error::New(napiEnv, "Could not set master fd to nonblocking.").ThrowAsJavaScriptException();
        return napiEnv.Null();
      }

      Napi::Object obj = Napi::Object::New(napiEnv);
      (obj).Set(Napi::String::New(napiEnv, "fd"),
        Napi::Number::New(napiEnv, master));
      (obj).Set(Napi::String::New(napiEnv, "pid"),
        Napi::Number::New(napiEnv, pid));
      (obj).Set(Napi::String::New(napiEnv, "pty"),
        Napi::String::New(napiEnv, ptsname(master)));

      // Set up process exit callback.
      Napi::Function cb = info[9].As<Napi::Function>();
      WaitForExit* waitForExit = new WaitForExit(cb, pid);
      waitForExit->Queue();

      return obj;
  }

  return napiEnv.Undefined();
}

Napi::Value PtyOpen(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.open(cols, rows)").ThrowAsJavaScriptException();
    return env.Null();
  }

  // size
  struct winsize winp;
  winp.ws_col = info[0].As<Napi::Number>().Int32Value();
  winp.ws_row = info[1].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // pty
  int master, slave;
  int ret = pty_openpty(&master, &slave, nullptr, NULL, &winp);

  if (ret == -1) {
    Napi::Error::New(env, "openpty(3) failed.").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (pty_nonblock(master) == -1) {
    Napi::Error::New(env, "Could not set master fd to nonblocking.").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (pty_nonblock(slave) == -1) {
    Napi::Error::New(env, "Could not set slave fd to nonblocking.").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object obj = Napi::Object::New(env);
  (obj).Set(Napi::String::New(env, "master"),
    Napi::Number::New(env, master));
  (obj).Set(Napi::String::New(env, "slave"),
    Napi::Number::New(env, slave));
  (obj).Set(Napi::String::New(env, "pty"),
    Napi::String::New(env, ptsname(master)));

  return obj;
}

Napi::Value PtyResize(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 3 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    Napi::Error::New(env, "Usage: pty.resize(fd, cols, rows)").ThrowAsJavaScriptException();
    return env.Null();
  }

  int fd = info[0].As<Napi::Number>().Int32Value();

  struct winsize winp;
  winp.ws_col = info[1].As<Napi::Number>().Int32Value();
  winp.ws_row = info[2].As<Napi::Number>().Int32Value();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  if (ioctl(fd, TIOCSWINSZ, &winp) == -1) {
    switch (errno) {
      case EBADF:  Napi::Error::New(env, "ioctl(2) failed, EBADF").ThrowAsJavaScriptException();
                   return env.Null();
      case EFAULT: Napi::Error::New(env, "ioctl(2) failed, EFAULT").ThrowAsJavaScriptException();
                   return env.Null();
      case EINVAL: Napi::Error::New(env, "ioctl(2) failed, EINVAL").ThrowAsJavaScriptException();
                   return env.Null();
      case ENOTTY: Napi::Error::New(env, "ioctl(2) failed, ENOTTY").ThrowAsJavaScriptException();
                   return env.Null();
    }
    Napi::Error::New(env, "ioctl(2) failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  return env.Undefined();
}

/**
 * Foreground Process Name
 */
Napi::Value PtyGetProc(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsString()) {
    Napi::Error::New(env, "Usage: pty.process(fd, tty)").ThrowAsJavaScriptException();
    return env.Null();
  }

  int fd = info[0].As<Napi::Number>().Int32Value();

  std::string tty_ = info[1].As<Napi::String>();
  char *tty = strdup(tty_.c_str());
  char *name = pty_getproc(fd, tty);
  free(tty);

  if (name == NULL) {
    return env.Undefined();
  }

  Napi::String name_ = Napi::String::New(env, name);
  free(name);
  return name_;
}

/**
 * execvpe
 */

// execvpe(3) is not portable.
// http://www.gnu.org/software/gnulib/manual/html_node/execvpe.html
static int
pty_execvpe(const char *file, char **argv, char **envp) {
  char **old = environ;
  environ = envp;
  int ret = execvp(file, argv);
  environ = old;
  return ret;
}

/**
 * Nonblocking FD
 */

static int
pty_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags == -1) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/**
 * pty_getproc
 * Taken from tmux.
 */

// Taken from: tmux (http://tmux.sourceforge.net/)
// Copyright (c) 2009 Nicholas Marriott <nicm@users.sourceforge.net>
// Copyright (c) 2009 Joshua Elsasser <josh@elsasser.org>
// Copyright (c) 2009 Todd Carson <toc@daybefore.net>
//
// Permission to use, copy, modify, and distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF MIND, USE, DATA OR PROFITS, WHETHER
// IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
// OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

#if defined(__linux__)

static char *
pty_getproc(int fd, char *tty) {
  FILE *f;
  char *path, *buf;
  size_t len;
  int ch;
  pid_t pgrp;
  int r;

  if ((pgrp = tcgetpgrp(fd)) == -1) {
    return NULL;
  }

  r = asprintf(&path, "/proc/%lld/cmdline", (long long)pgrp);
  if (r == -1 || path == NULL) return NULL;

  if ((f = fopen(path, "r")) == NULL) {
    free(path);
    return NULL;
  }

  free(path);

  len = 0;
  buf = NULL;
  while ((ch = fgetc(f)) != EOF) {
    if (ch == '\0') break;
    buf = (char *)realloc(buf, len + 2);
    if (buf == NULL) return NULL;
    buf[len++] = ch;
  }

  if (buf != NULL) {
    buf[len] = '\0';
  }

  fclose(f);
  return buf;
}

#elif defined(__APPLE__)

static char *
pty_getproc(int fd, char *tty) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, 0 };
  size_t size;
  struct kinfo_proc kp;

  if ((mib[3] = tcgetpgrp(fd)) == -1) {
    return NULL;
  }

  size = sizeof kp;
  if (sysctl(mib, 4, &kp, &size, NULL, 0) == -1) {
    return NULL;
  }

  if (size != (sizeof kp) || *kp.kp_proc.p_comm == '\0') {
    return NULL;
  }

  return strdup(kp.kp_proc.p_comm);
}

#else

static char *
pty_getproc(int fd, char *tty) {
  return NULL;
}

#endif

/**
 * openpty(3) / forkpty(3)
 */

static int
pty_openpty(int *amaster,
            int *aslave,
            char *name,
            const struct termios *termp,
            const struct winsize *winp) {
#if defined(__sun)
  char *slave_name;
  int slave;
  int master = open("/dev/ptmx", O_RDWR | O_NOCTTY);
  if (master == -1) return -1;
  if (amaster) *amaster = master;

  if (grantpt(master) == -1) goto err;
  if (unlockpt(master) == -1) goto err;

  slave_name = ptsname(master);
  if (slave_name == NULL) goto err;
  if (name) strcpy(name, slave_name);

  slave = open(slave_name, O_RDWR | O_NOCTTY);
  if (slave == -1) goto err;
  if (aslave) *aslave = slave;

  ioctl(slave, I_PUSH, "ptem");
  ioctl(slave, I_PUSH, "ldterm");
  ioctl(slave, I_PUSH, "ttcompat");

  if (termp) tcsetattr(slave, TCSAFLUSH, termp);
  if (winp) ioctl(slave, TIOCSWINSZ, winp);

  return 0;

err:
  close(master);
  return -1;
#else
  return openpty(amaster, aslave, name, (termios *)termp, (winsize *)winp);
#endif
}

static pid_t
pty_forkpty(int *amaster,
            char *name,
            const struct termios *termp,
            const struct winsize *winp) {
#if defined(__sun)
  int master, slave;

  int ret = pty_openpty(&master, &slave, name, termp, winp);
  if (ret == -1) return -1;
  if (amaster) *amaster = master;

  pid_t pid = fork();

  switch (pid) {
    case -1:  // error in fork, we are still in parent
      close(master);
      close(slave);
      return -1;
    case 0:  // we are in the child process
      close(master);
      setsid();

#if defined(TIOCSCTTY)
      // glibc does this
      if (ioctl(slave, TIOCSCTTY, NULL) == -1) {
        _exit(1);
      }
#endif

      dup2(slave, 0);
      dup2(slave, 1);
      dup2(slave, 2);

      if (slave > 2) close(slave);

      return 0;
    default:  // we are in the parent process
      close(slave);
      return pid;
  }

  return -1;
#else
  return forkpty(amaster, name, (termios *)termp, (winsize *)winp);
#endif
}


/**
 * Init
 */

Napi::Object init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  exports.Set(Napi::String::New(env, "fork"),    Napi::Function::New(env, PtyFork));
  exports.Set(Napi::String::New(env, "open"),    Napi::Function::New(env, PtyOpen));
  exports.Set(Napi::String::New(env, "resize"),  Napi::Function::New(env, PtyResize));
  exports.Set(Napi::String::New(env, "process"), Napi::Function::New(env, PtyGetProc));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init)
