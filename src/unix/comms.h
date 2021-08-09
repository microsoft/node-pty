#define COMM_PTY_FD 0
#define COMM_PIPE_FD 1

#define COMM_MSG_PATH 1
#define COMM_MSG_ARGV 2
#define COMM_MSG_ENV 3
#define COMM_MSG_CWD 4
#define COMM_MSG_UID 5
#define COMM_MSG_GID 6
#define COMM_MSG_GO_FOR_LAUNCH 99

#define COMM_MSG_EXEC_ERROR 100

void comm_send_int(int fd, int data);
void comm_send_str(int fd, char *str);
void comm_send_str_array(int fd, char **arr);
int comm_recv_int(int fd);
char* comm_recv_str(int fd);
char** comm_recv_str_array(int fd);
