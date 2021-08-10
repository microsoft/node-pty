#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

#include "comms.h"

/* environ for execvpe */
/* node/src/node_child_process.cc */
#if defined(__APPLE__) && !TARGET_OS_IPHONE
  #include <crt_externs.h>
  #define environ (*_NSGetEnviron())
#else
  extern char **environ;
#endif

int main (int argc, char** argv) {
  sigset_t empty_set;
  sigemptyset(&empty_set);
  pthread_sigmask(SIG_SETMASK, &empty_set, nullptr);

  struct rlimit rlim_ofile;
  getrlimit(RLIMIT_NOFILE, &rlim_ofile);
  for (rlim_t fd = STDERR_FILENO + 1; fd < rlim_ofile.rlim_cur; fd++) {
    if (fd != COMM_PIPE_FD) {
      close(fd);
    }
  }

  setsid();

#if defined(TIOCSCTTY)
  // glibc does this
  if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1) {
    _exit(1);
  }
#endif

  char *cwd = argv[0];
  int uid = std::stoi(argv[1]);
  int gid = std::stoi(argv[2]);
  char *file = argv[3];
  argv = &argv[3];

  fcntl(COMM_PIPE_FD, F_SETFD, FD_CLOEXEC);

  if (strlen(cwd) && chdir(cwd) == -1) {
    perror("chdir(2) failed.");
    _exit(1);
  }
  if (uid != -1 && setuid(uid) == -1) {
    perror("setuid(2) failed.");
    _exit(1);
  }
  if (gid != -1 && setgid(gid) == -1) {
    perror("setgid(2) failed.");
    _exit(1);
  }

  execvp(file, argv);
  write(COMM_PIPE_FD, &errno, sizeof(errno));
  return 1;
}
