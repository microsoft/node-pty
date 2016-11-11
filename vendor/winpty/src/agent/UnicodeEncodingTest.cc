// Copyright (c) 2015 Ryan Prichard
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

// Encode every code-point using this module and verify that it matches the
// encoding generated using Windows WideCharToMultiByte.

#include "UnicodeEncoding.h"

#include <windows.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static void correctness()
{
    char mbstr1[4];
    char mbstr2[4];
    wchar_t wch[2];
    for (unsigned int code = 0; code < 0x110000; ++code) {

        if (code >= 0xD800 && code <= 0xDFFF) {
            // Skip the surrogate pair codepoints.  WideCharToMultiByte doesn't
            // encode them.
            continue;
        }

        int mblen1 = encodeUtf8(mbstr1, code);
        if (mblen1 <= 0) {
            printf("Error: 0x%04X: mblen1=%d\n", code, mblen1);
            continue;
        }

        int wlen = encodeUtf16(wch, code);
        if (wlen <= 0) {
            printf("Error: 0x%04X: wlen=%d\n", code, wlen);
            continue;
        }

        int mblen2 = WideCharToMultiByte(CP_UTF8, 0, wch, wlen, mbstr2, 4, NULL, NULL);
        if (mblen1 != mblen2) {
            printf("Error: 0x%04X: mblen1=%d, mblen2=%d\n", code, mblen1, mblen2);
            continue;
        }

        if (memcmp(mbstr1, mbstr2, mblen1) != 0) {
            printf("Error: 0x%04x: encodings are different\n", code);
            continue;
        }
    }
}

wchar_t g_wch_TEST[] = { 0xD840, 0xDC00 };
char g_ch_TEST[4];
wchar_t *volatile g_pwch = g_wch_TEST;
char *volatile g_pch = g_ch_TEST;
unsigned int volatile g_code = 0xA2000;

static void performance()
{
    {
        clock_t start = clock();
        for (long long i = 0; i < 250000000LL; ++i) {
            int mblen = WideCharToMultiByte(CP_UTF8, 0, g_pwch, 2, g_pch, 4, NULL, NULL);
            assert(mblen == 4);
        }
        clock_t stop = clock();
        printf("%.3fns per char\n", (double)(stop - start) / CLOCKS_PER_SEC * 4.0);
    }

    {
        clock_t start = clock();
        for (long long i = 0; i < 3000000000LL; ++i) {
            int mblen = encodeUtf8(g_pch, g_code);
            assert(mblen == 4);
        }
        clock_t stop = clock();
        printf("%.3fns per char\n", (double)(stop - start) / CLOCKS_PER_SEC / 3.0);
    }
}

int main()
{
    correctness();
    performance();
    return 0;
}
