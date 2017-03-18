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

#include "nan.h"

#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

#include <sys/types.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <fcntl.h>

/* forkpty */
/* http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html */
#if defined(__GLIBC__) || defined(__CYGWIN__)
#include <pty.h>
#elif defined(__APPLE__) || defined(__OpenBSD__) || defined(__NetBSD__)
/**
 * From node v0.10.28 (at least?) there is also a "util.h" in node/src, which
 * would confuse the compiler when looking for "util.h".
 */
#if NODE_VERSION_AT_LEAST(0, 10, 28)
#include <../include/util.h>
#else
#include <util.h>
#endif
#elif defined(__FreeBSD__)
#include <libutil.h>
#elif defined(__sun)
#include <stropts.h> /* for I_PUSH */
#else
#include <pty.h>
#endif

#include <termios.h> /* tcgetattr, tty_ioctl */

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

/**
 * Namespace
 */

using namespace node;
using namespace v8;

/**
 * Structs
 */

struct pty_baton {
  Nan::Persistent<Function> cb;
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

static void
pty_waitpid(void *);

static void
#if NODE_VERSION_AT_LEAST(0, 11, 0)
pty_after_waitpid(uv_async_t *);
#else
pty_after_waitpid(uv_async_t *, int);
#endif

static void
pty_after_close(uv_handle_t *);

/**
 * PtyFork
 * pty.fork(file, args, env, cwd, cols, rows, uid, gid, onexit)
 */

NAN_METHOD(PtyFork) {
  Nan::HandleScope scope;

  if (info.Length() != 9
      || !info[0]->IsString() // file
      || !info[1]->IsArray() // args
      || !info[2]->IsArray() // env
      || !info[3]->IsString() // cwd
      || !info[4]->IsNumber() // cols
      || !info[5]->IsNumber() // rows
      || !info[6]->IsNumber() // uid
      || !info[7]->IsNumber() // gid
      || !info[8]->IsFunction() // onexit
  ) {
    return Nan::ThrowError(
      "Usage: pty.fork(file, args, env, cwd, cols, rows, uid, gid, onexit)");
  }

  // Make sure the process still listens to SIGINT
  signal(SIGINT, SIG_DFL);

  // file
  String::Utf8Value file(info[0]->ToString());

  // args
  int i = 0;
  Local<Array> argv_ = Local<Array>::Cast(info[1]);
  int argc = argv_->Length();
  int argl = argc + 1 + 1;
  char **argv = new char*[argl];
  argv[0] = strdup(*file);
  argv[argl-1] = NULL;
  for (; i < argc; i++) {
    String::Utf8Value arg(argv_->Get(Nan::New<Integer>(i))->ToString());
    argv[i+1] = strdup(*arg);
  }

  // env
  i = 0;
  Local<Array> env_ = Local<Array>::Cast(info[2]);
  int envc = env_->Length();
  char **env = new char*[envc+1];
  env[envc] = NULL;
  for (; i < envc; i++) {
    String::Utf8Value pair(env_->Get(Nan::New<Integer>(i))->ToString());
    env[i] = strdup(*pair);
  }

  // cwd
  String::Utf8Value cwd_(info[3]->ToString());
  char *cwd = strdup(*cwd_);

  // size
  struct winsize winp;
  winp.ws_col = info[4]->IntegerValue();
  winp.ws_row = info[5]->IntegerValue();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // termios
  struct termios* term = new termios();
#if defined(IUTF8)
  term->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT | IUTF8;
#else
  term->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT | UTF8;
#endif
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

  cfsetspeed(term, B38400);

  // uid / gid
  int uid = info[6]->IntegerValue();
  int gid = info[7]->IntegerValue();

  // fork the pty
  int master = -1;
  char name[40];
  pid_t pid = pty_forkpty(&master, name, term, &winp);

  if (pid) {
    for (i = 0; i < argl; i++) free(argv[i]);
    delete[] argv;
    for (i = 0; i < envc; i++) free(env[i]);
    delete[] env;
    free(cwd);
  }

  switch (pid) {
    case -1:
      return Nan::ThrowError("forkpty(3) failed.");
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
        return Nan::ThrowError("Could not set master fd to nonblocking.");
      }

      Local<Object> obj = Nan::New<Object>();
      Nan::Set(obj,
        Nan::New<String>("fd").ToLocalChecked(),
        Nan::New<Number>(master));
      Nan::Set(obj,
        Nan::New<String>("pid").ToLocalChecked(),
        Nan::New<Number>(pid));
      Nan::Set(obj,
        Nan::New<String>("pty").ToLocalChecked(),
        Nan::New<String>(name).ToLocalChecked());

      pty_baton *baton = new pty_baton();
      baton->exit_code = 0;
      baton->signal_code = 0;
      baton->cb.Reset(Local<Function>::Cast(info[8]));
      baton->pid = pid;
      baton->async.data = baton;

      uv_async_init(uv_default_loop(), &baton->async, pty_after_waitpid);

      uv_thread_create(&baton->tid, pty_waitpid, static_cast<void*>(baton));

      return info.GetReturnValue().Set(obj);
  }

  return info.GetReturnValue().SetUndefined();
}

/**
 * PtyOpen
 * pty.open(cols, rows)
 */

NAN_METHOD(PtyOpen) {
  Nan::HandleScope scope;

  if (info.Length() != 2
      || !info[0]->IsNumber()
      || !info[1]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.open(cols, rows)");
  }

  // size
  struct winsize winp;
  winp.ws_col = info[0]->IntegerValue();
  winp.ws_row = info[1]->IntegerValue();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  // pty
  int master, slave;
  char name[40];
  int ret = pty_openpty(&master, &slave, name, NULL, &winp);

  if (ret == -1) {
    return Nan::ThrowError("openpty(3) failed.");
  }

  if (pty_nonblock(master) == -1) {
    return Nan::ThrowError("Could not set master fd to nonblocking.");
  }

  if (pty_nonblock(slave) == -1) {
    return Nan::ThrowError("Could not set slave fd to nonblocking.");
  }

  Local<Object> obj = Nan::New<Object>();
  Nan::Set(obj,
    Nan::New<String>("master").ToLocalChecked(),
    Nan::New<Number>(master));
  Nan::Set(obj,
    Nan::New<String>("slave").ToLocalChecked(),
    Nan::New<Number>(slave));
  Nan::Set(obj,
    Nan::New<String>("pty").ToLocalChecked(),
    Nan::New<String>(name).ToLocalChecked());

  return info.GetReturnValue().Set(obj);
}

/**
 * Resize Functionality
 * pty.resize(fd, cols, rows)
 */

NAN_METHOD(PtyResize) {
  Nan::HandleScope scope;

  if (info.Length() != 3
      || !info[0]->IsNumber()
      || !info[1]->IsNumber()
      || !info[2]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.resize(fd, cols, rows)");
  }

  int fd = info[0]->IntegerValue();

  struct winsize winp;
  winp.ws_col = info[1]->IntegerValue();
  winp.ws_row = info[2]->IntegerValue();
  winp.ws_xpixel = 0;
  winp.ws_ypixel = 0;

  if (ioctl(fd, TIOCSWINSZ, &winp) == -1) {
    return Nan::ThrowError("ioctl(2) failed.");
  }

  return info.GetReturnValue().SetUndefined();
}

/**
 * PtyGetProc
 * Foreground Process Name
 * pty.process(fd, tty)
 */

NAN_METHOD(PtyGetProc) {
  Nan::HandleScope scope;

  if (info.Length() != 2
      || !info[0]->IsNumber()
      || !info[1]->IsString()) {
    return Nan::ThrowError("Usage: pty.process(fd, tty)");
  }

  int fd = info[0]->IntegerValue();

  String::Utf8Value tty_(info[1]->ToString());
  char *tty = strdup(*tty_);
  char *name = pty_getproc(fd, tty);
  free(tty);

  if (name == NULL) {
    return info.GetReturnValue().SetUndefined();
  }

  Local<String> name_ = Nan::New<String>(name).ToLocalChecked();
  free(name);
  return info.GetReturnValue().Set(name_);
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
#if NODE_VERSION_AT_LEAST(0, 11, 0)
pty_after_waitpid(uv_async_t *async) {
#else
pty_after_waitpid(uv_async_t *async, int unhelpful) {
#endif
  Nan::HandleScope scope;
  pty_baton *baton = static_cast<pty_baton*>(async->data);

  Local<Value> argv[] = {
    Nan::New<Integer>(baton->exit_code),
    Nan::New<Integer>(baton->signal_code),
  };

  Local<Function> cb = Nan::New<Function>(baton->cb);
  baton->cb.Reset();
  memset(&baton->cb, -1, sizeof(baton->cb));
  Nan::Callback(cb).Call(Nan::GetCurrentContext()->Global(), 2, argv);

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

  if (*kp.kp_proc.p_comm == '\0') {
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
pty_openpty(int *amaster, int *aslave, char *name,
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
pty_forkpty(int *amaster, char *name,
            const struct termios *termp,
            const struct winsize *winp) {
#if defined(__sun)
  int master, slave;

  int ret = pty_openpty(&master, &slave, name, termp, winp);
  if (ret == -1) return -1;
  if (amaster) *amaster = master;

  pid_t pid = fork();

  switch (pid) {
    case -1:
      close(master);
      close(slave);
      return -1;
    case 0:
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
    default:
      close(slave);
      return pid;
  }

  return -1;
#else
  return forkpty(amaster, name, (termios *)termp, (winsize *)winp);
#endif
}

/*
#include <termios.h>

struct termios {
    tcflag_t c_iflag;   unsigned long   --> Number
    tcflag_t c_oflag;   unsigned long   --> Number
    tcflag_t c_cflag;   unsigned long   --> Number
    tcflag_t c_lflag;   unsigned long   --> Number
    cc_t c_cc[NCCS];    unsigned char[]	--> Buffer
    speed_t c_ispeed;   long --> Number
    speed_t c_ospeed;   long --> Number
};
*/
NAN_METHOD(PtyTcgetattr) {
  Nan::HandleScope scope;

  if (info.Length() != 1
      || !info[0]->IsNumber()) {
    return Nan::ThrowError("Usage: pty.tcgetattr(fd)");
  }

  int fd = info[0]->IntegerValue();

  struct termios t;

  if (tcgetattr(fd, &t))
    return Nan::ThrowError("tcgetattr failed.");

  Local<Object> obj = Nan::New<Object>();
  Nan::Set(obj,
    Nan::New<String>("c_iflag").ToLocalChecked(),
    Nan::New<Number>(t.c_iflag));
  Nan::Set(obj,
    Nan::New<String>("c_oflag").ToLocalChecked(),
    Nan::New<Number>(t.c_oflag));
  Nan::Set(obj,
    Nan::New<String>("c_cflag").ToLocalChecked(),
    Nan::New<Number>(t.c_cflag));
  Nan::Set(obj,
    Nan::New<String>("c_lflag").ToLocalChecked(),
    Nan::New<Number>(t.c_lflag));
  Nan::Set(obj,
    Nan::New<String>("c_ispeed").ToLocalChecked(),
    Nan::New<Number>(t.c_ispeed));
  Nan::Set(obj,
    Nan::New<String>("c_ospeed").ToLocalChecked(),
    Nan::New<Number>(t.c_ospeed));
  Nan::Set(obj,
    Nan::New<String>("c_cc").ToLocalChecked(),
    Nan::CopyBuffer((const char *) &t.c_cc, sizeof(t.c_cc)).ToLocalChecked());

  return info.GetReturnValue().Set(obj);
}

NAN_METHOD(PtyTcsetattr) {
  Nan::HandleScope scope;

  if (info.Length() != 9
      || !info[0]->IsNumber()
      || !info[1]->IsNumber()
      || !info[2]->IsNumber()
      || !info[3]->IsNumber()
      || !info[4]->IsNumber()
      || !info[5]->IsNumber()
      || !info[6]->IsNumber()
      || !info[7]->IsNumber()
      || !info[8]->IsObject()) {
    return Nan::ThrowError("Usage: pty.tcsetattr(fd, optional_actions, c_iflag, c_oflag, c_cflag, c_lflag, c_ispeed, c_ospeed, c_cc)");
  }

  // get c values
  int fd = info[0]->IntegerValue();
  int optional_actions = info[1]->IntegerValue();
  tcflag_t c_iflag = (tcflag_t) info[2]->Uint32Value();
  tcflag_t c_oflag = (tcflag_t) info[3]->Uint32Value();
  tcflag_t c_cflag = (tcflag_t) info[4]->Uint32Value();
  tcflag_t c_lflag = (tcflag_t) info[5]->Uint32Value();
  tcflag_t c_ispeed = (tcflag_t) info[6]->Uint32Value();
  tcflag_t c_ospeed = (tcflag_t) info[7]->Uint32Value();
  cc_t *c_cc = (cc_t *) node::Buffer::Data(info[8]->ToObject());

  // populate termios struct
  struct termios t;
  t.c_iflag = c_iflag;
  t.c_oflag = c_oflag;
  t.c_cflag = c_cflag;
  t.c_lflag = c_lflag;
  t.c_ispeed = c_ispeed;
  t.c_ospeed = c_ospeed;
  memcpy(&t.c_cc, c_cc, sizeof(t.c_cc));  // possible overflow???

  if (tcsetattr(fd, optional_actions, &t))
      return Nan::ThrowError("tcsetattr failed.");
}

#define S(s) #s

NAN_METHOD(GetTermiosDefinitions) {
  Nan::HandleScope scope;

  Local<Object> obj = Nan::New<Object>();

  // basic macro declarations from termios.h
  // commented out: not defined in ubuntu 14
  // c_iflag
  Nan::Set(obj, Nan::New<String>(S(IGNBRK)).ToLocalChecked(), Nan::New<Number>(IGNBRK));
  Nan::Set(obj, Nan::New<String>(S(BRKINT)).ToLocalChecked(), Nan::New<Number>(BRKINT));
  Nan::Set(obj, Nan::New<String>(S(IGNPAR)).ToLocalChecked(), Nan::New<Number>(IGNPAR));
  Nan::Set(obj, Nan::New<String>(S(PARMRK)).ToLocalChecked(), Nan::New<Number>(PARMRK));
  Nan::Set(obj, Nan::New<String>(S(INPCK)).ToLocalChecked(), Nan::New<Number>(INPCK));
  Nan::Set(obj, Nan::New<String>(S(ISTRIP)).ToLocalChecked(), Nan::New<Number>(ISTRIP));
  Nan::Set(obj, Nan::New<String>(S(INLCR)).ToLocalChecked(), Nan::New<Number>(INLCR));
  Nan::Set(obj, Nan::New<String>(S(IGNCR)).ToLocalChecked(), Nan::New<Number>(IGNCR));
  Nan::Set(obj, Nan::New<String>(S(ICRNL)).ToLocalChecked(), Nan::New<Number>(ICRNL));
  Nan::Set(obj, Nan::New<String>(S(IUCLC)).ToLocalChecked(), Nan::New<Number>(IUCLC));
  Nan::Set(obj, Nan::New<String>(S(IXON)).ToLocalChecked(), Nan::New<Number>(IXON));
  Nan::Set(obj, Nan::New<String>(S(IXANY)).ToLocalChecked(), Nan::New<Number>(IXANY));
  Nan::Set(obj, Nan::New<String>(S(IXOFF)).ToLocalChecked(), Nan::New<Number>(IXOFF));
  Nan::Set(obj, Nan::New<String>(S(IMAXBEL)).ToLocalChecked(), Nan::New<Number>(IMAXBEL));
  Nan::Set(obj, Nan::New<String>(S(IUTF8)).ToLocalChecked(), Nan::New<Number>(IUTF8));
  // c_oflag
  Nan::Set(obj, Nan::New<String>(S(OPOST)).ToLocalChecked(), Nan::New<Number>(OPOST));
  Nan::Set(obj, Nan::New<String>(S(OLCUC)).ToLocalChecked(), Nan::New<Number>(OLCUC));
  Nan::Set(obj, Nan::New<String>(S(ONLCR)).ToLocalChecked(), Nan::New<Number>(ONLCR));
  Nan::Set(obj, Nan::New<String>(S(OCRNL)).ToLocalChecked(), Nan::New<Number>(OCRNL));
  Nan::Set(obj, Nan::New<String>(S(ONOCR)).ToLocalChecked(), Nan::New<Number>(ONOCR));
  Nan::Set(obj, Nan::New<String>(S(ONLRET)).ToLocalChecked(), Nan::New<Number>(ONLRET));
  Nan::Set(obj, Nan::New<String>(S(OFILL)).ToLocalChecked(), Nan::New<Number>(OFILL));
  Nan::Set(obj, Nan::New<String>(S(OFDEL)).ToLocalChecked(), Nan::New<Number>(OFDEL));
  Nan::Set(obj, Nan::New<String>(S(NLDLY)).ToLocalChecked(), Nan::New<Number>(NLDLY));
  Nan::Set(obj, Nan::New<String>(S(CRDLY)).ToLocalChecked(), Nan::New<Number>(CRDLY));
  Nan::Set(obj, Nan::New<String>(S(TABDLY)).ToLocalChecked(), Nan::New<Number>(TABDLY));
  Nan::Set(obj, Nan::New<String>(S(BSDLY)).ToLocalChecked(), Nan::New<Number>(BSDLY));
  Nan::Set(obj, Nan::New<String>(S(VTDLY)).ToLocalChecked(), Nan::New<Number>(VTDLY));
  Nan::Set(obj, Nan::New<String>(S(FFDLY)).ToLocalChecked(), Nan::New<Number>(FFDLY));
  // c_cflag
  Nan::Set(obj, Nan::New<String>(S(CBAUD)).ToLocalChecked(), Nan::New<Number>(CBAUD));
  Nan::Set(obj, Nan::New<String>(S(CBAUDEX)).ToLocalChecked(), Nan::New<Number>(CBAUDEX));
  Nan::Set(obj, Nan::New<String>(S(CSIZE)).ToLocalChecked(), Nan::New<Number>(CSIZE));
  Nan::Set(obj, Nan::New<String>(S(CSTOPB)).ToLocalChecked(), Nan::New<Number>(CSTOPB));
  Nan::Set(obj, Nan::New<String>(S(CREAD)).ToLocalChecked(), Nan::New<Number>(CREAD));
  Nan::Set(obj, Nan::New<String>(S(PARENB)).ToLocalChecked(), Nan::New<Number>(PARENB));
  Nan::Set(obj, Nan::New<String>(S(PARODD)).ToLocalChecked(), Nan::New<Number>(PARODD));
  Nan::Set(obj, Nan::New<String>(S(HUPCL)).ToLocalChecked(), Nan::New<Number>(HUPCL));
  Nan::Set(obj, Nan::New<String>(S(CLOCAL)).ToLocalChecked(), Nan::New<Number>(CLOCAL));
  //Nan::Set(obj, Nan::New<String>(S(LOBLK)).ToLocalChecked(), Nan::New<Number>(LOBLK));
  Nan::Set(obj, Nan::New<String>(S(CIBAUD)).ToLocalChecked(), Nan::New<Number>(CIBAUD));
  Nan::Set(obj, Nan::New<String>(S(CMSPAR)).ToLocalChecked(), Nan::New<Number>(CMSPAR));
  Nan::Set(obj, Nan::New<String>(S(CRTSCTS)).ToLocalChecked(), Nan::New<Number>(CRTSCTS));
  // c_lflag
  Nan::Set(obj, Nan::New<String>(S(ISIG)).ToLocalChecked(), Nan::New<Number>(ISIG));
  Nan::Set(obj, Nan::New<String>(S(ICANON)).ToLocalChecked(), Nan::New<Number>(ICANON));
  Nan::Set(obj, Nan::New<String>(S(XCASE)).ToLocalChecked(), Nan::New<Number>(XCASE));
  Nan::Set(obj, Nan::New<String>(S(ECHO)).ToLocalChecked(), Nan::New<Number>(ECHO));
  Nan::Set(obj, Nan::New<String>(S(ECHOE)).ToLocalChecked(), Nan::New<Number>(ECHOE));
  Nan::Set(obj, Nan::New<String>(S(ECHOK)).ToLocalChecked(), Nan::New<Number>(ECHOK));
  Nan::Set(obj, Nan::New<String>(S(ECHONL)).ToLocalChecked(), Nan::New<Number>(ECHONL));
  Nan::Set(obj, Nan::New<String>(S(ECHOCTL)).ToLocalChecked(), Nan::New<Number>(ECHOCTL));
  Nan::Set(obj, Nan::New<String>(S(ECHOPRT)).ToLocalChecked(), Nan::New<Number>(ECHOPRT));
  Nan::Set(obj, Nan::New<String>(S(ECHOKE)).ToLocalChecked(), Nan::New<Number>(ECHOKE));
  //Nan::Set(obj, Nan::New<String>(S(DEFECHO)).ToLocalChecked(), Nan::New<Number>(DEFECHO));
  Nan::Set(obj, Nan::New<String>(S(FLUSHO)).ToLocalChecked(), Nan::New<Number>(FLUSHO));
  Nan::Set(obj, Nan::New<String>(S(NOFLSH)).ToLocalChecked(), Nan::New<Number>(NOFLSH));
  Nan::Set(obj, Nan::New<String>(S(TOSTOP)).ToLocalChecked(), Nan::New<Number>(TOSTOP));
  Nan::Set(obj, Nan::New<String>(S(PENDIN)).ToLocalChecked(), Nan::New<Number>(PENDIN));
  Nan::Set(obj, Nan::New<String>(S(IEXTEN)).ToLocalChecked(), Nan::New<Number>(IEXTEN));
  // c_cc
  Nan::Set(obj, Nan::New<String>(S(VDISCARD)).ToLocalChecked(), Nan::New<Number>(VDISCARD));
  //Nan::Set(obj, Nan::New<String>(S(VDSUSP)).ToLocalChecked(), Nan::New<Number>(VDSUSP));
  Nan::Set(obj, Nan::New<String>(S(VEOF)).ToLocalChecked(), Nan::New<Number>(VEOF));
  Nan::Set(obj, Nan::New<String>(S(VEOL)).ToLocalChecked(), Nan::New<Number>(VEOL));
  Nan::Set(obj, Nan::New<String>(S(VEOL2)).ToLocalChecked(), Nan::New<Number>(VEOL2));
  Nan::Set(obj, Nan::New<String>(S(VERASE)).ToLocalChecked(), Nan::New<Number>(VERASE));
  Nan::Set(obj, Nan::New<String>(S(VINTR)).ToLocalChecked(), Nan::New<Number>(VINTR));
  Nan::Set(obj, Nan::New<String>(S(VKILL)).ToLocalChecked(), Nan::New<Number>(VKILL));
  Nan::Set(obj, Nan::New<String>(S(VLNEXT)).ToLocalChecked(), Nan::New<Number>(VLNEXT));
  Nan::Set(obj, Nan::New<String>(S(VMIN)).ToLocalChecked(), Nan::New<Number>(VMIN));
  Nan::Set(obj, Nan::New<String>(S(VQUIT)).ToLocalChecked(), Nan::New<Number>(VQUIT));
  Nan::Set(obj, Nan::New<String>(S(VREPRINT)).ToLocalChecked(), Nan::New<Number>(VREPRINT));
  Nan::Set(obj, Nan::New<String>(S(VSTART)).ToLocalChecked(), Nan::New<Number>(VSTART));
  //Nan::Set(obj, Nan::New<String>(S(VSTATUS)).ToLocalChecked(), Nan::New<Number>(VSTATUS));
  Nan::Set(obj, Nan::New<String>(S(VSTOP)).ToLocalChecked(), Nan::New<Number>(VSTOP));
  Nan::Set(obj, Nan::New<String>(S(VSUSP)).ToLocalChecked(), Nan::New<Number>(VSUSP));
  //Nan::Set(obj, Nan::New<String>(S(VSWTCH)).ToLocalChecked(), Nan::New<Number>(VSWTCH));
  Nan::Set(obj, Nan::New<String>(S(VTIME)).ToLocalChecked(), Nan::New<Number>(VTIME));
  Nan::Set(obj, Nan::New<String>(S(VWERASE)).ToLocalChecked(), Nan::New<Number>(VWERASE));
  // optional_actions
  Nan::Set(obj, Nan::New<String>(S(TCSANOW)).ToLocalChecked(), Nan::New<Number>(TCSANOW));
  Nan::Set(obj, Nan::New<String>(S(TCSADRAIN)).ToLocalChecked(), Nan::New<Number>(TCSADRAIN));
  Nan::Set(obj, Nan::New<String>(S(TCSAFLUSH)).ToLocalChecked(), Nan::New<Number>(TCSAFLUSH));

  return info.GetReturnValue().Set(obj);
}

/**
 * Init
 */

NAN_MODULE_INIT(init) {
  Nan::HandleScope scope;
  Nan::Set(target,
    Nan::New<String>("fork").ToLocalChecked(),
    Nan::New<FunctionTemplate>(PtyFork)->GetFunction());
  Nan::Set(target,
    Nan::New<String>("open").ToLocalChecked(),
    Nan::New<FunctionTemplate>(PtyOpen)->GetFunction());
  Nan::Set(target,
    Nan::New<String>("resize").ToLocalChecked(),
    Nan::New<FunctionTemplate>(PtyResize)->GetFunction());
  Nan::Set(target,
    Nan::New<String>("process").ToLocalChecked(),
    Nan::New<FunctionTemplate>(PtyGetProc)->GetFunction());
  Nan::Set(target,
      Nan::New<String>("tcgetattr").ToLocalChecked(),
      Nan::New<FunctionTemplate>(PtyTcgetattr)->GetFunction());
  Nan::Set(target,
      Nan::New<String>("tcsetattr").ToLocalChecked(),
      Nan::New<FunctionTemplate>(PtyTcsetattr)->GetFunction());
  Nan::Set(target,
      Nan::New<String>("get_termios_definitions").ToLocalChecked(),
      Nan::New<FunctionTemplate>(GetTermiosDefinitions)->GetFunction());
}

NODE_MODULE(pty, init)
