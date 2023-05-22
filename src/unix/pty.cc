/**
 * Copyright (c) 2012-2015, Christopher Jeffrey (MIT License)
 * Copyright (c) 2017, Daniel Imms (MIT License)
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

#include <nan.h>
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
#if defined(__linux__)
#include <pty.h>
#elif defined(__APPLE__)
#include <util.h>
#elif defined(__FreeBSD__)
#include <libutil.h>
#endif

/* Some platforms name VWERASE and VDISCARD differently */
#if !defined(VWERASE) && defined(VWERSE)
#define VWERASE	VWERSE
#endif
#if !defined(VDISCARD) && defined(VDISCRD)
#define VDISCARD	VDISCRD
#endif

/* for pty_getproc */
#if defined(__linux__)
#include <stdio.h>
#include <stdint.h>
#elif defined(__APPLE__)
#include <libproc.h>
#include <os/availability.h>
#include <paths.h>
#include <spawn.h>
#include <sys/event.h>
#include <termios.h>
#endif

/* NSIG - macro for highest signal + 1, should be defined */
#ifndef NSIG
#define NSIG 32
#endif

/* macOS 10.14 back does not define this constant */
#ifndef POSIX_SPAWN_SETSID
  #define POSIX_SPAWN_SETSID 1024
#endif

/* environ for execvpe */
/* node/src/node_child_process.cc */
#if !defined(__APPLE__)
extern char **environ;
#endif

#if defined(__APPLE__)
extern "C" {
// Changes the current thread's directory to a path or directory file
// descriptor. libpthread only exposes a syscall wrapper starting in
// macOS 10.12, but the system call dates back to macOS 10.5. On older OSes,
// the syscall is issued directly.
int pthread_chdir_np(const char* dir) API_AVAILABLE(macosx(10.12));
int pthread_fchdir_np(int fd) API_AVAILABLE(macosx(10.12));
}

#define HANDLE_EINTR(x) ({ \
  int eintr_wrapper_counter = 0; \
  decltype(x) eintr_wrapper_result; \
  do { \
    eintr_wrapper_result = (x); \
  } while (eintr_wrapper_result == -1 && errno == EINTR && \
           eintr_wrapper_counter++ < 100); \
  eintr_wrapper_result; \
})
#endif

/**
 * Structs
 */

struct pty_baton {
  Nan::Persistent<v8::Function> cb;
  int exit_code;
  int signal_code;
  pid_t pid;
  uv_async_t async;
  uv_thread_t tid;
};

/**
 * Methods
 */

NAN_METHOD(PtyFork);
NAN_METHOD(PtyOpen);
NAN_METHOD(PtyResize);
NAN_METHOD(PtyGetProc);

/**
 * Functions
 */

static int
pty_nonblock(int);

#if defined(__APPLE__)
static char *
pty_getproc(int);
#else
static char *
pty_getproc(int, char *);
#endif

static void
pty_waitpid(void *);

static void
pty_after_waitpid(uv_async_t *);

static void
pty_after_close(uv_handle_t *);

#if defined(__APPLE__) || defined(__OpenBSD__)
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err);
#endif

NAN_METHOD(PtyFork) {
  Nan::HandleScope scope;

  if (info.Length() != 11 ||
      !info[0]->IsString() ||
      !info[1]->IsArray() ||
      !info[2]->IsArray() ||
      !info[3]->IsString() ||
      !info[4]->IsNumber() ||
      !info[5]->IsNumber() ||
      !info[6]->IsNumber() ||
      !info[7]->IsNumber() ||
      !info[8]->IsBoolean() ||
      !info[9]->IsString() ||
      !info[10]->IsFunction()) {
    return Nan::ThrowError(
        "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, utf8, helperPath, onexit)");
  }

  // file
  Nan::Utf8String file(info[0]);

  // args
  v8::Local<v8::Array> argv_ = v8::Local<v8::Array>::Cast(info[1]);

  // env
  v8::Local<v8::Array> env_ = v8::Local<v8::Array>::Cast(info[2]);
  int envc = env_->Length();
  char **env = new char*[envc+1];
  env[envc] = NULL;
  for (int i = 0; i < envc; i++) {
    Nan::Utf8String pair(Nan::Get(env_, i).ToLocalChecked());
    env[i] = strdup(*pair);
  }

  // cwd
  Nan::Utf8String cwd_(info[3]);

  // size
  struct winsize winp;
  winp.ws_col = info[4]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_row = info[5]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

#if !defined(__APPLE__)
  // uid / gid
  int uid = info[6]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  int gid = info[7]->IntegerValue(Nan::GetCurrentContext()).FromJust();
#endif

  // termios
  struct termios t = termios();
  struct termios *term = &t;
  term->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT;
  if (Nan::To<bool>(info[8]).FromJust()) {
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

  // helperPath
  Nan::Utf8String helper_path(info[9]);

  pid_t pid;
  int master;
#if defined(__APPLE__)
  int argc = argv_->Length();
  int argl = argc + 4;
  char **argv = new char*[argl];
  argv[0] = strdup(*helper_path);
  argv[1] = strdup(*cwd_);
  argv[2] = strdup(*file);
  argv[argl - 1] = NULL;
  for (int i = 0; i < argc; i++) {
    Nan::Utf8String arg(Nan::Get(argv_, i).ToLocalChecked());
    argv[i + 3] = strdup(*arg);
  }

  int err = -1;
  pty_posix_spawn(argv, env, term, &winp, &master, &pid, &err);
  if (err != 0) {
    Nan::ThrowError("posix_spawnp failed.");
    goto done;
  }
  if (pty_nonblock(master) == -1) {
    Nan::ThrowError("Could not set master fd to nonblocking.");
    goto done;
  }
#else
  int argc = argv_->Length();
  int argl = argc + 2;
  char **argv = new char*[argl];
  argv[0] = strdup(*file);
  argv[argl - 1] = NULL;
  for (int i = 0; i < argc; i++) {
    Nan::Utf8String arg(Nan::Get(argv_, i).ToLocalChecked());
    argv[i + 1] = strdup(*arg);
  }

  char* cwd = strdup(*cwd_);
  sigset_t newmask, oldmask;
  struct sigaction sig_action;
  // temporarily block all signals
  // this is needed due to a race condition in openpty
  // and to avoid running signal handlers in the child
  // before exec* happened
  sigfillset(&newmask);
  pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);

  pid = forkpty(&master, nullptr, static_cast<termios*>(term), static_cast<winsize*>(&winp));

  if (!pid) {
    // remove all signal handler from child
    sig_action.sa_handler = SIG_DFL;
    sig_action.sa_flags = 0;
    sigemptyset(&sig_action.sa_mask);
    for (int i = 0 ; i < NSIG ; i++) {    // NSIG is a macro for all signals + 1
      sigaction(i, &sig_action, NULL);
    }
  } else {
    for (int i = 0; i < argl; i++) free(argv[i]);
    delete[] argv;

    for (int i = 0; i < envc; i++) free(env[i]);
    delete[] env;

    free(cwd);
  }

  // reenable signals
  pthread_sigmask(SIG_SETMASK, &oldmask, NULL);

  switch (pid) {
    case -1:
      Nan::ThrowError("forkpty(3) failed.");
      goto done;
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

      {
        char **old = environ;
        environ = env;
        execvp(argv[0], argv);
        environ = old;
        perror("execvp(3) failed.");
        _exit(1);
      }
    default:
      if (pty_nonblock(master) == -1) {
        Nan::ThrowError("Could not set master fd to nonblocking.");
        goto done;
      }
  }
#endif

  {
    v8::Local<v8::Object> obj = Nan::New<v8::Object>();
    Nan::Set(obj,
      Nan::New<v8::String>("fd").ToLocalChecked(),
      Nan::New<v8::Number>(master));
    Nan::Set(obj,
      Nan::New<v8::String>("pid").ToLocalChecked(),
      Nan::New<v8::Number>(pid));
    Nan::Set(obj,
      Nan::New<v8::String>("pty").ToLocalChecked(),
      Nan::New<v8::String>(ptsname(master)).ToLocalChecked());

    pty_baton *baton = new pty_baton();
    baton->exit_code = 0;
    baton->signal_code = 0;
    baton->cb.Reset(v8::Local<v8::Function>::Cast(info[10]));
    baton->pid = pid;
    baton->async.data = baton;

    uv_async_init(uv_default_loop(), &baton->async, pty_after_waitpid);

    uv_thread_create(&baton->tid, pty_waitpid, static_cast<void*>(baton));

    return info.GetReturnValue().Set(obj);
  }

done:
#if defined(__APPLE__)
  for (int i = 0; i < argl; i++) free(argv[i]);
  delete[] argv;

  for (int i = 0; i < envc; i++) free(env[i]);
  delete[] env;
#endif
  return info.GetReturnValue().SetUndefined();
}

NAN_METHOD(PtyOpen) {
  Nan::HandleScope scope;

  if (info.Length() != 2 ||
      !info[0]->IsNumber() ||
      !info[1]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.open(cols, rows)");
  }

  // size
  struct winsize winp;
  winp.ws_col = info[0]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_row = info[1]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // pty
  int master, slave;
  int ret = openpty(&master, &slave, nullptr, NULL, static_cast<winsize*>(&winp));

  if (ret == -1) {
    return Nan::ThrowError("openpty(3) failed.");
  }

  if (pty_nonblock(master) == -1) {
    return Nan::ThrowError("Could not set master fd to nonblocking.");
  }

  if (pty_nonblock(slave) == -1) {
    return Nan::ThrowError("Could not set slave fd to nonblocking.");
  }

  v8::Local<v8::Object> obj = Nan::New<v8::Object>();
  Nan::Set(obj,
    Nan::New<v8::String>("master").ToLocalChecked(),
    Nan::New<v8::Number>(master));
  Nan::Set(obj,
    Nan::New<v8::String>("slave").ToLocalChecked(),
    Nan::New<v8::Number>(slave));
  Nan::Set(obj,
    Nan::New<v8::String>("pty").ToLocalChecked(),
    Nan::New<v8::String>(ptsname(master)).ToLocalChecked());

  return info.GetReturnValue().Set(obj);
}

NAN_METHOD(PtyResize) {
  Nan::HandleScope scope;

  if (info.Length() != 3 ||
      !info[0]->IsNumber() ||
      !info[1]->IsNumber() ||
      !info[2]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.resize(fd, cols, rows)");
  }

  int fd = info[0]->IntegerValue(Nan::GetCurrentContext()).FromJust();

  struct winsize winp;
  winp.ws_col = info[1]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_row = info[2]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  if (ioctl(fd, TIOCSWINSZ, &winp) == -1) {
    switch (errno) {
      case EBADF: return Nan::ThrowError("ioctl(2) failed, EBADF");
      case EFAULT: return Nan::ThrowError("ioctl(2) failed, EFAULT");
      case EINVAL: return Nan::ThrowError("ioctl(2) failed, EINVAL");
      case ENOTTY: return Nan::ThrowError("ioctl(2) failed, ENOTTY");
    }
    return Nan::ThrowError("ioctl(2) failed");
  }

  return info.GetReturnValue().SetUndefined();
}

/**
 * Foreground Process Name
 */
NAN_METHOD(PtyGetProc) {
  Nan::HandleScope scope;

#if defined(__APPLE__)
  if (info.Length() != 1 ||
      !info[0]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.process(pid)");
  }

  int pid = info[0]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  char *name = pty_getproc(pid);
#else
  if (info.Length() != 2 ||
      !info[0]->IsNumber() ||
      !info[1]->IsString()) {
    return Nan::ThrowError("Usage: pty.process(fd, tty)");
  }

  int fd = info[0]->IntegerValue(Nan::GetCurrentContext()).FromJust();

  Nan::Utf8String tty_(info[1]);
  char *tty = strdup(*tty_);
  char *name = pty_getproc(fd, tty);
  free(tty);
#endif

  if (name == NULL) {
    return info.GetReturnValue().SetUndefined();
  }

  v8::Local<v8::String> name_ = Nan::New<v8::String>(name).ToLocalChecked();
  free(name);
  return info.GetReturnValue().Set(name_);
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
 * pty_waitpid
 * Wait for SIGCHLD to read exit status.
 */

static void
pty_waitpid(void *data) {
  int ret;
  int stat_loc;
  pty_baton *baton = static_cast<pty_baton*>(data);
  errno = 0;
#if defined(__APPLE__)
  // Based on
  // https://source.chromium.org/chromium/chromium/src/+/main:base/process/kill_mac.cc;l=35-69?
  int kq = HANDLE_EINTR(kqueue());
  struct kevent change = {0};
  EV_SET(&change, baton->pid, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
  ret = HANDLE_EINTR(kevent(kq, &change, 1, NULL, 0, NULL));
  if (ret == -1) {
    if (errno == ESRCH) {
      // At this point, one of the following has occurred:
      // 1. The process has died but has not yet been reaped.
      // 2. The process has died and has already been reaped.
      // 3. The process is in the process of dying. It's no longer
      //    kqueueable, but it may not be waitable yet either. Mark calls
      //    this case the "zombie death race".
      ret = HANDLE_EINTR(waitpid(baton->pid, &stat_loc, WNOHANG));
      if (ret == 0) {
        ret = kill(baton->pid, SIGKILL);
        if (ret != -1) {
          HANDLE_EINTR(waitpid(baton->pid, &stat_loc, 0));
        }
      }
    }
  } else {
    struct kevent event = {0};
    ret = HANDLE_EINTR(kevent(kq, NULL, 0, &event, 1, NULL));
    if (ret == 1) {
      if ((event.fflags & NOTE_EXIT) &&
          (event.ident == static_cast<uintptr_t>(baton->pid))) {
        // The process is dead or dying. This won't block for long, if at
        // all.
        HANDLE_EINTR(waitpid(baton->pid, &stat_loc, 0));
      }
    }
  }
#else
  if ((ret = waitpid(baton->pid, &stat_loc, 0)) != baton->pid) {
    if (ret == -1 && errno == EINTR) {
      return pty_waitpid(baton);
    }
    if (ret == -1 && errno == ECHILD) {
      // XXX node v0.8.x seems to have this problem.
      // waitpid is already handled elsewhere.
      ;
    } else {
      assert(false);
    }
  }
#endif

  if (WIFEXITED(stat_loc)) {
    baton->exit_code = WEXITSTATUS(stat_loc); // errno?
  }

  if (WIFSIGNALED(stat_loc)) {
    baton->signal_code = WTERMSIG(stat_loc);
  }

  uv_async_send(&baton->async);
}

/**
 * pty_after_waitpid
 * Callback after exit status has been read.
 */

static void
pty_after_waitpid(uv_async_t *async) {
  Nan::HandleScope scope;
  pty_baton *baton = static_cast<pty_baton*>(async->data);

  v8::Local<v8::Value> argv[] = {
    Nan::New<v8::Integer>(baton->exit_code),
    Nan::New<v8::Integer>(baton->signal_code),
  };

  v8::Local<v8::Function> cb = Nan::New<v8::Function>(baton->cb);
  baton->cb.Reset();
  memset(&baton->cb, -1, sizeof(baton->cb));
  Nan::AsyncResource resource("pty_after_waitpid");
  resource.runInAsyncScope(Nan::GetCurrentContext()->Global(), cb, 2, argv);

  uv_close((uv_handle_t *)async, pty_after_close);
}

/**
 * pty_after_close
 * uv_close() callback - free handle data
 */

static void
pty_after_close(uv_handle_t *handle) {
  uv_async_t *async = (uv_async_t *)handle;
  pty_baton *baton = static_cast<pty_baton*>(async->data);
  delete baton;
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
pty_getproc(int pid) {
  char pname[MAXCOMLEN + 1];
  if (!proc_name(pid, pname, sizeof(pname))) {
    return NULL;
  }

  return strdup(pname);
}

#else

static char *
pty_getproc(int fd, char *tty) {
  return NULL;
}

#endif

#if defined(__APPLE__)
static void
pty_posix_spawn(char** argv, char** env,
                const struct termios *termp,
                const struct winsize *winp,
                int* master,
                pid_t* pid,
                int* err) {
  int low_fds[3];
  size_t count = 0;

  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;
  }

  int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
              POSIX_SPAWN_SETSIGDEF |
              POSIX_SPAWN_SETSIGMASK |
              POSIX_SPAWN_SETSID;
  *master = posix_openpt(O_RDWR);
  if (*master == -1) {
    return;
  }

  int res = grantpt(*master) || unlockpt(*master);
  if (res == -1) {
    return;
  }

  // Use TIOCPTYGNAME instead of ptsname() to avoid threading problems.
  int slave;
  char slave_pty_name[128];
  res = ioctl(*master, TIOCPTYGNAME, slave_pty_name);
  if (res == -1) {
    return;
  }

  slave = open(slave_pty_name, O_RDWR | O_NOCTTY);
  if (slave == -1) {
    return;
  }

  if (termp) {
    res = tcsetattr(slave, TCSANOW, termp);
    if (res == -1) {
      return;
    };
  }

  if (winp) {
    res = ioctl(slave, TIOCSWINSZ, winp);
    if (res == -1) {
      return;
    }
  }

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);
  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&acts, slave);
  posix_spawn_file_actions_addclose(&acts, *master);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  *err = posix_spawnattr_setflags(&attrs, flags);
  if (*err != 0) {
    goto done;
  }

  sigset_t signal_set;
  /* Reset all signal the child to their default behavior */
  sigfillset(&signal_set);
  *err = posix_spawnattr_setsigdefault(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  /* Reset the signal mask for all signals */
  sigemptyset(&signal_set);
  *err = posix_spawnattr_setsigmask(&attrs, &signal_set);
  if (*err != 0) {
    goto done;
  }

  do
    *err = posix_spawn(pid, argv[0], &acts, &attrs, argv, env);
  while (*err == EINTR);
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
}
#endif

/**
 * Init
 */

NAN_MODULE_INIT(init) {
  Nan::HandleScope scope;
  Nan::Export(target, "fork", PtyFork);
  Nan::Export(target, "open", PtyOpen);
  Nan::Export(target, "resize", PtyResize);
  Nan::Export(target, "process", PtyGetProc);
}

NODE_MODULE(pty, init)
