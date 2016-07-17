// Copyright (c) 2011-2015 Ryan Prichard
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

#include <stdio.h>
#include <stdlib.h>

#include "Agent.h"
#include "DebugShowInput.h"
#include "../shared/WinptyAssert.h"
#include "../shared/WinptyVersion.h"

const char USAGE[] =
"Usage: %s controlPipeName dataPipeName cols rows\n"
"\n"
"Ordinarily, this program is launched by winpty.dll and is not directly\n"
"useful to winpty users.  However, it also has options intended for\n"
"debugging winpty.\n"
"\n"
"Usage: %s [options]\n"
"\n"
"Options:\n"
"  --show-input     Dump INPUT_RECORDs from the console input buffer\n"
"  --show-input --with-mouse\n"
"                   Include MOUSE_INPUT_RECORDs in the dump output\n"
"  --version        Print the winpty version\n";

static wchar_t *heapMbsToWcs(const char *text)
{
    size_t len = mbstowcs(NULL, text, 0);
    ASSERT(len != (size_t)-1);
    wchar_t *ret = new wchar_t[len + 1];
    size_t len2 = mbstowcs(ret, text, len + 1);
    ASSERT(len == len2);
    return ret;
}

int main(int argc, char *argv[])
{
    if (argc == 2 && !strcmp(argv[1], "--version")) {
        dumpVersionToStdout();
        return 0;
    }

    if (argc == 2 && !strcmp(argv[1], "--show-input")) {
        debugShowInput(false);
        return 0;
    } else if (argc == 3 && !strcmp(argv[1], "--show-input") && !strcmp(argv[2], "--with-mouse")) {
        debugShowInput(true);
        return 0;
    }

    if (argc != 5) {
        fprintf(stderr, USAGE, argv[0], argv[0]);
        return 1;
    }

    Agent agent(heapMbsToWcs(argv[1]),
                heapMbsToWcs(argv[2]),
                atoi(argv[3]),
                atoi(argv[4]));
    agent.run();
}
