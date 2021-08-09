#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <signal.h>
#include <termios.h>
#include <unistd.h>
#include <stdio.h>

#include "comms.h"

#define PIPE_FD (STDERR_FILENO + 1)

/* environ for execvpe */
/* node/src/node_child_process.cc */
#if defined(__APPLE__) && !TARGET_OS_IPHONE
  #include <crt_externs.h>
  #define environ (*_NSGetEnviron())
#else
  extern char **environ;
#endif

int main () {
  sigset_t empty_set;
  sigemptyset(&empty_set);
  pthread_sigmask(SIG_SETMASK, &empty_set, nullptr);

  struct rlimit rlim_ofile;
  getrlimit(RLIMIT_NOFILE, &rlim_ofile);
  for (rlim_t fd = 0; fd < rlim_ofile.rlim_cur; fd++) {
    if (fd != COMM_PIPE_FD && fd != COMM_PTY_FD) {
      close(fd);
    }
  }

  setsid();

  dup2(COMM_PIPE_FD, PIPE_FD);
  close(COMM_PIPE_FD);
  dup2(COMM_PTY_FD, STDIN_FILENO);
  dup2(COMM_PTY_FD, STDOUT_FILENO);
  dup2(COMM_PTY_FD, STDERR_FILENO);

#if defined(TIOCSCTTY)
  // glibc does this
  if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1) {
    _exit(1);
  }
#endif

  char *file = nullptr;
  char **argv = nullptr;
  char **env = nullptr;

  while (true) {
    const int type = comm_recv_int(PIPE_FD);
    if (type == COMM_MSG_PATH) {
      file = comm_recv_str(PIPE_FD);
    } else if (type == COMM_MSG_ARGV) {
      argv = comm_recv_str_array(PIPE_FD);
    } else if (type == COMM_MSG_ENV) {
      env = comm_recv_str_array(PIPE_FD);
    } else if (type == COMM_MSG_CWD) {
      if (chdir(comm_recv_str(PIPE_FD)) == -1) {
        perror("chdir(2) failed.");
        _exit(1);
      }
    } else if (type == COMM_MSG_UID) {
      if (setuid(comm_recv_int(PIPE_FD)) == -1) {
        perror("setuid(2) failed.");
        _exit(1);
      }
    } else if (type == COMM_MSG_GID) {
      if (setgid(comm_recv_int(PIPE_FD)) == -1) {
        perror("setgid(2) failed.");
        _exit(1);
      }
    } else if (type == COMM_MSG_GO_FOR_LAUNCH) {
      break;
    }
  }

  environ = env;
  fcntl(PIPE_FD, F_SETFD, FD_CLOEXEC);

  auto error = execvp(file, argv);

  comm_send_int(PIPE_FD, COMM_MSG_EXEC_ERROR);
  comm_send_int(PIPE_FD, error);
  return 1;
}
