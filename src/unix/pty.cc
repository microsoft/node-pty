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
#include <spawn.h>

#include "comms.h"

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

#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
  #define HAVE_POSIX_SPAWN_CLOEXEC_DEFAULT 1
#else
  #define HAVE_POSIX_SPAWN_CLOEXEC_DEFAULT 0
  #define POSIX_SPAWN_CLOEXEC_DEFAULT 0
#endif

#ifndef POSIX_SPAWN_USEVFORK
  #define POSIX_SPAWN_USEVFORK 0
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

static char *
pty_getproc(int, char *);

static int
pty_openpty(int *, int *, char *,
            const struct termios *,
            const struct winsize *);

static void
pty_waitpid(void *);

static void
pty_after_waitpid(uv_async_t *);

static void
pty_after_close(uv_handle_t *);

static void throw_for_errno(const char* message, int _errno) {
  Nan::ThrowError((
    message + std::string(strerror(_errno))
  ).c_str());
}

NAN_METHOD(PtyFork) {
  Nan::HandleScope scope;

  if (info.Length() != 12 ||
      !info[0]->IsString() ||
      !info[1]->IsArray() ||
      !info[2]->IsArray() ||
      !info[3]->IsString() ||
      !info[4]->IsNumber() ||
      !info[5]->IsNumber() ||
      !info[6]->IsNumber() ||
      !info[7]->IsNumber() ||
      !info[8]->IsBoolean() ||
      !info[9]->IsBoolean() ||
      !info[10]->IsFunction() ||
      !info[11]->IsString()) {
    return Nan::ThrowError(
        "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, utf8, closeFDs, onexit, helperPath)");
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

  // uid / gid
  int uid = info[6]->IntegerValue(Nan::GetCurrentContext()).FromJust();
  int gid = info[7]->IntegerValue(Nan::GetCurrentContext()).FromJust();

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

  // closeFDs
  bool closeFDs = Nan::To<bool>(info[9]).FromJust();
  bool explicitlyCloseFDs = closeFDs && !HAVE_POSIX_SPAWN_CLOEXEC_DEFAULT;

  // helperPath
  Nan::Utf8String helper_path_(info[11]);
  char *helper_path = strdup(*helper_path_);

  const int EXTRA_ARGS = 6;
  int argc = argv_->Length();
  int argl = argc + EXTRA_ARGS + 1;
  char **argv = new char*[argl];
  argv[0] = strdup(helper_path);
  argv[1] = strdup(*cwd_);
  argv[2] = strdup(std::to_string(uid).c_str());
  argv[3] = strdup(std::to_string(gid).c_str());
  argv[4] = strdup(explicitlyCloseFDs ? "1": "0");
  argv[5] = strdup(*file);
  argv[argl - 1] = NULL;
  for (int i = 0; i < argc; i++) {
    Nan::Utf8String arg(Nan::Get(argv_, i).ToLocalChecked());
    argv[i + EXTRA_ARGS] = strdup(*arg);
  }

  cfsetispeed(term, B38400);
  cfsetospeed(term, B38400);

  sigset_t newmask, oldmask;
  int flags = POSIX_SPAWN_USEVFORK;

  // temporarily block all signals
  // this is needed due to a race condition in openpty
  // and to avoid running signal handlers in the child
  // before exec* happened
  sigfillset(&newmask);
  pthread_sigmask(SIG_SETMASK, &newmask, &oldmask);

  int master, slave;
  int ret = pty_openpty(&master, &slave, nullptr, term, &winp);
  if (ret == -1) {
    perror("openpty failed");
    Nan::ThrowError("openpty failed.");
    goto done;
  }

  int comms_pipe[2];
  if (pipe(comms_pipe)) {
    perror("pipe() failed");
    Nan::ThrowError("pipe() failed.");
    goto done;
  }

  posix_spawn_file_actions_t acts;
  posix_spawn_file_actions_init(&acts);
  posix_spawn_file_actions_adddup2(&acts, slave, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&acts, slave, STDERR_FILENO);
  posix_spawn_file_actions_adddup2(&acts, comms_pipe[1], COMM_PIPE_FD);
  posix_spawn_file_actions_addclose(&acts, comms_pipe[1]);

  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  if (closeFDs) {
    flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
  }
  posix_spawnattr_setflags(&attrs, flags);

  { // suppresses "jump bypasses variable initialization" errors
    pid_t pid;
    auto error = posix_spawn(&pid, argv[0], &acts, &attrs, argv, env);

    close(comms_pipe[1]);

    // reenable signals
    pthread_sigmask(SIG_SETMASK, &oldmask, NULL);

    if (error) {
      throw_for_errno("posix_spawn failed: ", error);
      goto done;
    }

    int helper_error[2];
    auto bytes_read = read(comms_pipe[0], &helper_error, sizeof(helper_error));
    close(comms_pipe[0]);

    if (bytes_read == sizeof(helper_error)) {
      if (helper_error[0] == COMM_ERR_EXEC) {
        throw_for_errno("exec() failed: ", helper_error[1]);
      } else if (helper_error[0] == COMM_ERR_CHDIR) {
        throw_for_errno("chdir() failed: ", helper_error[1]);
      } else if (helper_error[0] == COMM_ERR_SETUID) {
        throw_for_errno("setuid() failed: ", helper_error[1]);
      } else if (helper_error[0] == COMM_ERR_SETGID) {
        throw_for_errno("setgid() failed: ", helper_error[1]);
      }
      goto done;
    }

    if (pty_nonblock(master) == -1) {
      Nan::ThrowError("Could not set master fd to nonblocking.");
      goto done;
    }

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

    info.GetReturnValue().Set(obj);
  }
done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  if (argv) {
    for (int i = 0; i < argl; i++) free(argv[i]);
    delete[] argv;
  }
  if (env) {
    for (int i = 0; i < envc; i++) free(env[i]);
    delete[] env;
  }
  free(helper_path);
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
  int ret = pty_openpty(&master, &slave, nullptr, NULL, &winp);

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
