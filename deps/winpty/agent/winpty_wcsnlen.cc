#include "winpty_wcsnlen.h"

#include "AgentAssert.h"

// Workaround.  MinGW (from mingw.org) does not have wcsnlen.  MinGW-w64 *does*
// have wcsnlen, but use this function for consistency.
size_t winpty_wcsnlen(const wchar_t *s, size_t maxlen) {
    ASSERT(s != NULL);
    for (size_t i = 0; i < maxlen; ++i) {
        if (s[i] == L'\0') {
            return i;
        }
    }
    return maxlen;
}
