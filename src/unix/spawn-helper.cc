#include <fcntl.h>
#include <signal.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <termios.h>
#include <unistd.h>
#include <string.h>

#include "comms.h"

void bail (int type, int code) {
  int buf[2] = { type, code };
  (void)! write(COMM_PIPE_FD, &buf, sizeof(buf));
  _exit(1);
}

int main (int argc, char** argv) {
  sigset_t empty_set;
  sigemptyset(&empty_set);
  pthread_sigmask(SIG_SETMASK, &empty_set, nullptr);

  setsid();

#if defined(TIOCSCTTY)
  // glibc does this
  if (ioctl(STDIN_FILENO, TIOCSCTTY, NULL) == -1) {
    _exit(1);
  }
#else
  char *slave_path = ttyname(STDIN_FILENO);
  // open implicit attaches a process to a terminal device if:
  // - process has no controlling terminal yet
  // - O_NOCTTY is not set
  close(open(slave_path, O_RDWR));
#endif

  char *cwd = argv[0];
  int uid = std::stoi(argv[1]);
  int gid = std::stoi(argv[2]);
  bool closeFDs = std::stoi(argv[3]);
  char *file = argv[4];
  argv = &argv[4];

  fcntl(COMM_PIPE_FD, F_SETFD, FD_CLOEXEC);

  if (strlen(cwd) && chdir(cwd) == -1) {
    bail(COMM_ERR_CHDIR, errno);
  }
  if (uid != -1 && setuid(uid) == -1) {
    bail(COMM_ERR_SETUID, errno);
  }
  if (gid != -1 && setgid(gid) == -1) {
    bail(COMM_ERR_SETGID, errno);
  }
  if (closeFDs) {
    struct rlimit rlim_ofile;
    getrlimit(RLIMIT_NOFILE, &rlim_ofile);
    for (rlim_t fd = STDERR_FILENO + 1; fd < rlim_ofile.rlim_cur; fd++) {
      if (fd != COMM_PIPE_FD) {
        close(fd);
      }
    }
  }

  execvp(file, argv);
  bail(COMM_ERR_EXEC, errno);
  return 1;
}
