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

#include "ConsoleInput.h"

#include <stdio.h>
#include <string.h>

#include <algorithm>
#include <sstream>
#include <string>

#include "DebugShowInput.h"
#include "DefaultInputMap.h"
#include "DsrSender.h"
#include "Win32Console.h"
#include "../shared/DebugClient.h"
#include "../shared/UnixCtrlChars.h"

#ifndef MAPVK_VK_TO_VSC
#define MAPVK_VK_TO_VSC 0
#endif

namespace {

struct MouseRecord {
    bool release;
    int flags;
    COORD coord;

    std::string toString() const;
};

std::string MouseRecord::toString() const {
    std::stringstream ss;
    ss << "pos=" << std::dec << coord.X << "," << coord.Y
       << " flags=0x"
       << std::hex << flags;
    if (release) {
        ss << " release";
    }
    return ss.str();
}

const int kIncompleteEscapeTimeoutMs = 1000u;

#define CHECK(cond)                                 \
        do {                                        \
            if (!(cond)) { return 0; }              \
        } while(0)

#define ADVANCE()                                   \
        do {                                        \
            pch++;                                  \
            if (pch == stop) { return -1; }         \
        } while(0)

#define SCAN_INT(out, maxLen)                       \
        do {                                        \
            (out) = 0;                              \
            CHECK(isdigit(*pch));                   \
            const char *begin = pch;                \
            do {                                    \
                CHECK(pch - begin + 1 < maxLen);    \
                (out) = (out) * 10 + *pch - '0';    \
                ADVANCE();                          \
            } while (isdigit(*pch));                \
        } while(0)

#define SCAN_SIGNED_INT(out, maxLen)                \
        do {                                        \
            bool negative = false;                  \
            if (*pch == '-') {                      \
                negative = true;                    \
                ADVANCE();                          \
            }                                       \
            SCAN_INT(out, maxLen);                  \
            if (negative) {                         \
                (out) = -(out);                     \
            }                                       \
        } while(0)

// Match the Device Status Report console input:  ESC [ nn ; mm R
// Returns:
// 0   no match
// >0  match, returns length of match
// -1  incomplete match
static int matchDsr(const char *input, int inputSize)
{
    int32_t dummy = 0;
    const char *pch = input;
    const char *stop = input + inputSize;
    CHECK(*pch == '\x1B');  ADVANCE();
    CHECK(*pch == '[');     ADVANCE();
    SCAN_INT(dummy, 8);
    CHECK(*pch == ';');     ADVANCE();
    SCAN_INT(dummy, 8);
    CHECK(*pch == 'R');
    return pch - input + 1;
}

static int matchMouseDefault(const char *input, int inputSize,
                             MouseRecord &out)
{
    const char *pch = input;
    const char *stop = input + inputSize;
    CHECK(*pch == '\x1B');              ADVANCE();
    CHECK(*pch == '[');                 ADVANCE();
    CHECK(*pch == 'M');                 ADVANCE();
    out.flags = (*pch - 32) & 0xFF;     ADVANCE();
    out.coord.X = (*pch - '!') & 0xFF;
    ADVANCE();
    out.coord.Y = (*pch - '!') & 0xFF;
    out.release = false;
    return pch - input + 1;
}

static int matchMouse1006(const char *input, int inputSize, MouseRecord &out)
{
    const char *pch = input;
    const char *stop = input + inputSize;
    int32_t temp;
    CHECK(*pch == '\x1B');      ADVANCE();
    CHECK(*pch == '[');         ADVANCE();
    CHECK(*pch == '<');         ADVANCE();
    SCAN_INT(out.flags, 8);
    CHECK(*pch == ';');         ADVANCE();
    SCAN_SIGNED_INT(temp, 8); out.coord.X = temp - 1;
    CHECK(*pch == ';');         ADVANCE();
    SCAN_SIGNED_INT(temp, 8); out.coord.Y = temp - 1;
    CHECK(*pch == 'M' || *pch == 'm');
    out.release = (*pch == 'm');
    return pch - input + 1;
}

static int matchMouse1015(const char *input, int inputSize, MouseRecord &out)
{
    const char *pch = input;
    const char *stop = input + inputSize;
    int32_t temp;
    CHECK(*pch == '\x1B');      ADVANCE();
    CHECK(*pch == '[');         ADVANCE();
    SCAN_INT(out.flags, 8); out.flags -= 32;
    CHECK(*pch == ';');         ADVANCE();
    SCAN_SIGNED_INT(temp, 8); out.coord.X = temp - 1;
    CHECK(*pch == ';');         ADVANCE();
    SCAN_SIGNED_INT(temp, 8); out.coord.Y = temp - 1;
    CHECK(*pch == 'M');
    out.release = false;
    return pch - input + 1;
}

static int matchMouseRecord(const char *input, int inputSize, MouseRecord &out)
{
    memset(&out, 0, sizeof(out));
    int ret;
    if ((ret = matchMouse1006(input, inputSize, out)) != 0) { return ret; }
    if ((ret = matchMouse1015(input, inputSize, out)) != 0) { return ret; }
    if ((ret = matchMouseDefault(input, inputSize, out)) != 0) { return ret; }
    return 0;
}

#undef CHECK
#undef ADVANCE
#undef SCAN_INT

// Return the byte size of a UTF-8 character using the value of the first
// byte.
static int utf8CharLength(char firstByte)
{
    // This code would probably be faster if it used __builtin_clz.
    if ((firstByte & 0x80) == 0) {
        return 1;
    } else if ((firstByte & 0xE0) == 0xC0) {
        return 2;
    } else if ((firstByte & 0xF0) == 0xE0) {
        return 3;
    } else if ((firstByte & 0xF8) == 0xF0) {
        return 4;
    } else if ((firstByte & 0xFC) == 0xF8) {
        return 5;
    } else if ((firstByte & 0xFE) == 0xFC) {
        return 6;
    } else {
        // Malformed UTF-8.
        return 1;
    }
}

} // anonymous namespace

ConsoleInput::ConsoleInput(DsrSender *dsrSender) :
    m_console(new Win32Console),
    m_dsrSender(dsrSender),
    m_dsrSent(false),
    m_lastWriteTick(0),
    m_mouseButtonState(0),
    m_mouseInputEnabled(false)
{
    addDefaultEntriesToInputMap(m_inputMap);
    if (hasDebugFlag("dump_input_map")) {
        m_inputMap.dumpInputMap();
    }
}

ConsoleInput::~ConsoleInput()
{
    delete m_console;
}

void ConsoleInput::writeInput(const std::string &input)
{
    if (input.size() == 0) {
        return;
    }

    if (isTracingEnabled()) {
        static bool debugInput = hasDebugFlag("input");
        if (debugInput) {
            std::string dumpString;
            for (size_t i = 0; i < input.size(); ++i) {
                const char ch = input[i];
                const char ctrl = decodeUnixCtrlChar(ch);
                if (ctrl != '\0') {
                    dumpString += '^';
                    dumpString += ctrl;
                } else {
                    dumpString += ch;
                }
            }
            dumpString += " (";
            for (size_t i = 0; i < input.size(); ++i) {
                if (i > 0) {
                    dumpString += ' ';
                }
                const unsigned char uch = input[i];
                char buf[32];
                sprintf(buf, "%02X", uch);
                dumpString += buf;
            }
            dumpString += ')';
            trace("input chars: %s", dumpString.c_str());
        }
    }

    m_byteQueue.append(input);
    doWrite(false);
    if (!m_byteQueue.empty() && !m_dsrSent) {
        trace("send DSR");
        m_dsrSender->sendDsr();
        m_dsrSent = true;
    }
    m_lastWriteTick = GetTickCount();
}

void ConsoleInput::flushIncompleteEscapeCode()
{
    if (!m_byteQueue.empty() &&
            (GetTickCount() - m_lastWriteTick) > kIncompleteEscapeTimeoutMs) {
        doWrite(true);
        m_byteQueue.clear();
    }
}

void ConsoleInput::doWrite(bool isEof)
{
    const char *data = m_byteQueue.c_str();
    std::vector<INPUT_RECORD> records;
    size_t idx = 0;
    while (idx < m_byteQueue.size()) {
        int charSize = scanInput(records, &data[idx], m_byteQueue.size() - idx, isEof);
        if (charSize == -1)
            break;
        idx += charSize;
    }
    m_byteQueue.erase(0, idx);
    m_console->writeInput(records.data(), records.size());
}

int ConsoleInput::scanInput(std::vector<INPUT_RECORD> &records,
                            const char *input,
                            int inputSize,
                            bool isEof)
{
    ASSERT(inputSize >= 1);

    // Ctrl-C.
    if (input[0] == '\x03' && m_console->processedInputMode()) {
        trace("Ctrl-C");
        BOOL ret = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
        trace("GenerateConsoleCtrlEvent: %d", ret);
        return 1;
    }

    if (input[0] == '\x1B') {
        // Attempt to match the Device Status Report (DSR) reply.
        int dsrLen = matchDsr(input, inputSize);
        if (dsrLen > 0) {
            trace("Received a DSR reply");
            m_dsrSent = false;
            return dsrLen;
        } else if (!isEof && dsrLen == -1) {
            // Incomplete DSR match.
            trace("Incomplete DSR match");
            return -1;
        }

        int mouseLen = scanMouseInput(records, input, inputSize);
        if (mouseLen > 0 || (!isEof && mouseLen == -1)) {
            return mouseLen;
        }
    }

    // Search the input map.
    InputMap::Key match;
    bool incomplete;
    int matchLen = m_inputMap.lookupKey(input, inputSize, match, incomplete);
    if (!isEof && incomplete) {
        // Incomplete match -- need more characters (or wait for a
        // timeout to signify flushed input).
        trace("Incomplete escape sequence");
        return -1;
    } else if (matchLen > 0) {
        appendKeyPress(records,
                       match.virtualKey,
                       match.unicodeChar,
                       match.keyState);
        return matchLen;
    }

    // Recognize Alt-<character>.
    //
    // This code doesn't match Alt-ESC, which is encoded as `ESC ESC`, but
    // maybe it should.  I was concerned that pressing ESC rapidly enough could
    // accidentally trigger Alt-ESC.  (e.g. The user would have to be faster
    // than the DSR flushing mechanism or use a decrepit terminal.  The user
    // might be on a slow network connection.)
    if (input[0] == '\x1B' && inputSize >= 2 && input[1] != '\x1B') {
        int len = utf8CharLength(input[1]);
        if (1 + len > inputSize) {
            // Incomplete character.
            trace("Incomplete UTF-8 character in Alt-<Char>");
            return -1;
        }
        appendUtf8Char(records, &input[1], len, LEFT_ALT_PRESSED);
        return 1 + len;
    }

    // A UTF-8 character.
    int len = utf8CharLength(input[0]);
    if (len > inputSize) {
        // Incomplete character.
        trace("Incomplete UTF-8 character");
        return -1;
    }
    appendUtf8Char(records, &input[0], len, 0);
    return len;
}

int ConsoleInput::scanMouseInput(std::vector<INPUT_RECORD> &records,
                                 const char *input,
                                 int inputSize)
{
    MouseRecord record;
    int len = matchMouseRecord(input, inputSize, record);
    if (len == 0) {
        return 0;
    }

    if (isTracingEnabled()) {
        static bool debugInput = hasDebugFlag("input");
        if (debugInput) {
            trace("mouse input: %s", record.toString().c_str());
        }
    }

    const int button = record.flags & 0x03;
    INPUT_RECORD newRecord = {0};
    newRecord.EventType = MOUSE_EVENT;
    MOUSE_EVENT_RECORD &mer = newRecord.Event.MouseEvent;

    mer.dwMousePosition.X =
        m_mouseWindowRect.Left +
            std::max(0, std::min<int>(record.coord.X,
                                      m_mouseWindowRect.width() - 1));

    mer.dwMousePosition.Y =
        m_mouseWindowRect.Top +
            std::max(0, std::min<int>(record.coord.Y,
                                      m_mouseWindowRect.height() - 1));

    // The modifier state is neatly independent of everything else.
    if (record.flags & 0x04) { mer.dwControlKeyState |= SHIFT_PRESSED;     }
    if (record.flags & 0x08) { mer.dwControlKeyState |= LEFT_ALT_PRESSED;  }
    if (record.flags & 0x10) { mer.dwControlKeyState |= LEFT_CTRL_PRESSED; }

    if (record.flags & 0x40) {
        // Mouse wheel
        mer.dwEventFlags |= MOUSE_WHEELED;
        if (button == 0) {
            // up
            mer.dwButtonState |= 0x00780000;
        } else if (button == 1) {
            // down
            mer.dwButtonState |= 0xff880000;
        } else {
            // Invalid -- do nothing
            return len;
        }
    } else {
        // Ordinary mouse event
        if (record.flags & 0x20) { mer.dwEventFlags |= MOUSE_MOVED; }
        if (button == 3) {
            m_mouseButtonState = 0;
            // Potentially advance double-click detection.
            m_doubleClick.released = true;
        } else {
            const DWORD relevantFlag =
                (button == 0) ? FROM_LEFT_1ST_BUTTON_PRESSED :
                (button == 1) ? FROM_LEFT_2ND_BUTTON_PRESSED :
                (button == 2) ? RIGHTMOST_BUTTON_PRESSED :
                0;
            ASSERT(relevantFlag != 0);
            if (record.release) {
                m_mouseButtonState &= ~relevantFlag;
                if (relevantFlag == m_doubleClick.button) {
                    // Potentially advance double-click detection.
                    m_doubleClick.released = true;
                } else {
                    // End double-click detection.
                    m_doubleClick = DoubleClickDetection();
                }
            } else if ((m_mouseButtonState & relevantFlag) == 0) {
                // The button has been newly pressed.
                m_mouseButtonState |= relevantFlag;
                // Detect a double-click.  This code looks for an exact
                // coordinate match, which is stricter than what Windows does,
                // but Windows has pixel coordinates, and we only have terminal
                // coordinates.
                if (m_doubleClick.button == relevantFlag &&
                        m_doubleClick.pos == record.coord &&
                        (GetTickCount() - m_doubleClick.tick <
                            GetDoubleClickTime())) {
                    // Record a double-click and end double-click detection.
                    mer.dwEventFlags |= DOUBLE_CLICK;
                    m_doubleClick = DoubleClickDetection();
                } else {
                    // Begin double-click detection.
                    m_doubleClick.button = relevantFlag;
                    m_doubleClick.pos = record.coord;
                    m_doubleClick.tick = GetTickCount();
                }
            }
        }
    }

    mer.dwButtonState |= m_mouseButtonState;

    if (m_mouseInputEnabled) {
        if (isTracingEnabled()) {
            static bool debugInput = hasDebugFlag("input");
            if (debugInput) {
                trace("mouse event: %s", mouseEventToString(mer).c_str());
            }
        }

        records.push_back(newRecord);
    }

    return len;
}

void ConsoleInput::appendUtf8Char(std::vector<INPUT_RECORD> &records,
                                  const char *charBuffer,
                                  const int charLen,
                                  const uint16_t keyState)
{
    WCHAR wideInput[2];
    int wideLen = MultiByteToWideChar(CP_UTF8,
                                      0,
                                      charBuffer,
                                      charLen,
                                      wideInput,
                                      sizeof(wideInput) / sizeof(wideInput[0]));
    for (int i = 0; i < wideLen; ++i) {
        short charScan = VkKeyScan(wideInput[i]);
        uint16_t virtualKey = 0;
        uint16_t charKeyState = keyState;
        if (charScan != -1) {
            virtualKey = charScan & 0xFF;
            if (charScan & 0x100)
                charKeyState |= SHIFT_PRESSED;
            else if (charScan & 0x200)
                charKeyState |= LEFT_CTRL_PRESSED;
            else if (charScan & 0x400)
                charKeyState |= LEFT_ALT_PRESSED;
        }
        appendKeyPress(records, virtualKey, wideInput[i], charKeyState);
    }
}

void ConsoleInput::appendKeyPress(std::vector<INPUT_RECORD> &records,
                                  uint16_t virtualKey,
                                  uint16_t unicodeChar,
                                  uint16_t keyState)
{
    const bool ctrl = keyState & LEFT_CTRL_PRESSED;
    const bool alt = keyState & LEFT_ALT_PRESSED;
    const bool shift = keyState & SHIFT_PRESSED;

    if (isTracingEnabled()) {
        static bool debugInput = hasDebugFlag("input");
        if (debugInput) {
            InputMap::Key key = { virtualKey, unicodeChar, keyState };
            trace("keypress: %s", key.toString().c_str());
        }
    }

    uint16_t stepKeyState = 0;
    if (ctrl) {
        stepKeyState |= LEFT_CTRL_PRESSED;
        appendInputRecord(records, TRUE, VK_CONTROL, 0, stepKeyState);
    }
    if (alt) {
        stepKeyState |= LEFT_ALT_PRESSED;
        appendInputRecord(records, TRUE, VK_MENU, 0, stepKeyState);
    }
    if (shift) {
        stepKeyState |= SHIFT_PRESSED;
        appendInputRecord(records, TRUE, VK_SHIFT, 0, stepKeyState);
    }
    if (ctrl && alt) {
        // This behavior seems arbitrary, but it's what I see in the Windows 7
        // console.
        unicodeChar = 0;
    }
    appendInputRecord(records, TRUE, virtualKey, unicodeChar, stepKeyState);
    if (alt) {
        // This behavior seems arbitrary, but it's what I see in the Windows 7
        // console.
        unicodeChar = 0;
    }
    appendInputRecord(records, FALSE, virtualKey, unicodeChar, stepKeyState);
    if (shift) {
        stepKeyState &= ~SHIFT_PRESSED;
        appendInputRecord(records, FALSE, VK_SHIFT, 0, stepKeyState);
    }
    if (alt) {
        stepKeyState &= ~LEFT_ALT_PRESSED;
        appendInputRecord(records, FALSE, VK_MENU, 0, stepKeyState);
    }
    if (ctrl) {
        stepKeyState &= ~LEFT_CTRL_PRESSED;
        appendInputRecord(records, FALSE, VK_CONTROL, 0, stepKeyState);
    }
}

void ConsoleInput::appendInputRecord(std::vector<INPUT_RECORD> &records,
                                     BOOL keyDown,
                                     uint16_t virtualKey,
                                     uint16_t unicodeChar,
                                     uint16_t keyState)
{
    INPUT_RECORD ir;
    memset(&ir, 0, sizeof(ir));
    ir.EventType = KEY_EVENT;
    ir.Event.KeyEvent.bKeyDown = keyDown;
    ir.Event.KeyEvent.wRepeatCount = 1;
    ir.Event.KeyEvent.wVirtualKeyCode = virtualKey;
    ir.Event.KeyEvent.wVirtualScanCode =
            MapVirtualKey(virtualKey, MAPVK_VK_TO_VSC);
    ir.Event.KeyEvent.uChar.UnicodeChar = unicodeChar;
    ir.Event.KeyEvent.dwControlKeyState = keyState;
    records.push_back(ir);
}
