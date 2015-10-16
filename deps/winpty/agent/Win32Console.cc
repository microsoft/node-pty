// Copyright (c) 2011-2012 Ryan Prichard
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

#include "Win32Console.h"
#include "AgentAssert.h"
#include "../shared/DebugClient.h"
#include <string>
#include <wchar.h>
#include <windows.h>

Win32Console::Win32Console() : m_titleWorkBuf(16)
{
    m_conin = GetStdHandle(STD_INPUT_HANDLE);
    m_conout = CreateFileW(L"CONOUT$",
                           GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_EXISTING, 0, NULL);
    ASSERT(m_conout != INVALID_HANDLE_VALUE);
}

Win32Console::~Win32Console()
{
    CloseHandle(m_conout);
}

HANDLE Win32Console::conin()
{
    return m_conin;
}

HANDLE Win32Console::conout()
{
    return m_conout;
}

HWND Win32Console::hwnd()
{
    return GetConsoleWindow();
}

void Win32Console::postCloseMessage()
{
    HWND h = hwnd();
    if (h != NULL)
        PostMessage(h, WM_CLOSE, 0, 0);
}

void Win32Console::clearLines(
    int row,
    int count,
    const ConsoleScreenBufferInfo &info)
{
    // TODO: error handling
    const int width = info.bufferSize().X;
    DWORD actual = 0;
    if (!FillConsoleOutputCharacterW(
            m_conout, L' ', width * count, Coord(0, row),
            &actual) || static_cast<int>(actual) != width * count) {
        trace("FillConsoleOutputCharacterW failed");
    }
    if (!FillConsoleOutputAttribute(
            m_conout, info.wAttributes, width * count, Coord(0, row),
            &actual) || static_cast<int>(actual) != width * count) {
        trace("FillConsoleOutputAttribute failed");
    }
}

void Win32Console::clearAllLines(const ConsoleScreenBufferInfo &info)
{
    clearLines(0, info.bufferSize().Y, info);
}

ConsoleScreenBufferInfo Win32Console::bufferInfo()
{
    // TODO: error handling
    ConsoleScreenBufferInfo info;
    if (!GetConsoleScreenBufferInfo(m_conout, &info)) {
        trace("GetConsoleScreenBufferInfo failed");
    }
    return info;
}

Coord Win32Console::bufferSize()
{
    return bufferInfo().bufferSize();
}

SmallRect Win32Console::windowRect()
{
    return bufferInfo().windowRect();
}

void Win32Console::resizeBuffer(const Coord &size)
{
    // TODO: error handling
    if (!SetConsoleScreenBufferSize(m_conout, size)) {
        trace("SetConsoleScreenBufferSize failed");
    }
}

void Win32Console::moveWindow(const SmallRect &rect)
{
    // TODO: error handling
    if (!SetConsoleWindowInfo(m_conout, TRUE, &rect)) {
        trace("SetConsoleWindowInfo failed");
    }
}

Coord Win32Console::cursorPosition()
{
    return bufferInfo().dwCursorPosition;
}

void Win32Console::setCursorPosition(const Coord &coord)
{
    // TODO: error handling
    if (!SetConsoleCursorPosition(m_conout, coord)) {
        trace("SetConsoleCursorPosition failed");
    }
}

void Win32Console::writeInput(const INPUT_RECORD *ir, int count)
{
    // TODO: error handling
    DWORD dummy = 0;
    if (!WriteConsoleInput(m_conin, ir, count, &dummy)) {
        trace("WriteConsoleInput failed");
    }
}

bool Win32Console::processedInputMode()
{
    // TODO: error handling
    DWORD mode = 0;
    if (!GetConsoleMode(m_conin, &mode)) {
        trace("GetConsoleMode failed");
    }
    return (mode & ENABLE_PROCESSED_INPUT) == ENABLE_PROCESSED_INPUT;
}

void Win32Console::read(const SmallRect &rect, CHAR_INFO *data)
{
    // TODO: error handling
    SmallRect tmp(rect);
    if (!ReadConsoleOutputW(m_conout, data, rect.size(), Coord(), &tmp)) {
        trace("ReadConsoleOutput failed [x:%d,y:%d,w:%d,h:%d]",
              rect.Left, rect.Top, rect.width(), rect.height());
    }
}

void Win32Console::write(const SmallRect &rect, const CHAR_INFO *data)
{
    // TODO: error handling
    SmallRect tmp(rect);
    if (!WriteConsoleOutputW(m_conout, data, rect.size(), Coord(), &tmp)) {
        trace("WriteConsoleOutput failed");
    }
}

std::wstring Win32Console::title()
{
    while (true) {
        // The MSDN documentation for GetConsoleTitle is wrong.  It documents
        // nSize as the "size of the buffer pointed to by the lpConsoleTitle
        // parameter, in characters" and the successful return value as "the
        // length of the console window's title, in characters."  In fact,
        // nSize is in *bytes*.  In contrast, the return value is a count of
        // UTF-16 code units.  Make the buffer extra large so we can
        // technically match the documentation.
        DWORD count = GetConsoleTitleW(m_titleWorkBuf.data(),
                                       m_titleWorkBuf.size());
        if (count >= m_titleWorkBuf.size() / sizeof(wchar_t)) {
            m_titleWorkBuf.resize((count + 1) * sizeof(wchar_t));
            continue;
        }
        m_titleWorkBuf[count] = L'\0';
        return m_titleWorkBuf.data();
    }
}

void Win32Console::setTitle(const std::wstring &title)
{
    if (!SetConsoleTitleW(title.c_str())) {
        trace("SetConsoleTitleW failed");
    }
}

void Win32Console::setTextAttribute(WORD attributes)
{
    if (!SetConsoleTextAttribute(m_conout, attributes)) {
        trace("SetConsoleTextAttribute failed");
    }
}
