#include "WinptyVersion.h"

#include <stdio.h>

#define XSTRINGIFY(x) #x
#define STRINGIFY(x) XSTRINGIFY(x)

void dumpVersionToStdout() {
    printf("winpty version %s%s\n", STRINGIFY(WINPTY_VERSION), STRINGIFY(WINPTY_VERSION_SUFFIX));
    printf("commit %s\n", STRINGIFY(WINPTY_COMMIT_HASH));
}
