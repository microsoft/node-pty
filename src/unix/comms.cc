#include "comms.h"

#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>


void comm_send_int(int fd, int data) {
  send(fd, &data, sizeof(data), 0);
}

void comm_send_str(int fd, char *str) {
  comm_send_int(fd, strlen(str));
  send(fd, str, strlen(str), 0);
}

void comm_send_str_array(int fd, char **arr) {
  int len = 0;
  auto p = arr;
  while (*p) {
    len++;
    p++;
  }

  comm_send_int(fd, len);
  p = arr;
  while (*p) {
    comm_send_str(fd, *p);
    p++;
  }
}

int comm_recv_int(int fd) {
  int buf;
  recv(fd, &buf, sizeof(buf), 0);
  return buf;
}

char* comm_recv_str(int fd) {
  int len = comm_recv_int(fd);
  auto buf = new char[len + 1];
  recv(fd, buf, len, 0);
  buf[len] = 0;
  return buf;
}

char** comm_recv_str_array(int fd) {
  int len = comm_recv_int(fd);
  auto buf = new char*[len + 1];
  buf[len] = nullptr;
  for (int i = 0; i < len; i++) {
    buf[i] = comm_recv_str(fd);
  }
  return buf;
}
