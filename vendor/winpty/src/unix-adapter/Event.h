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

#ifndef UNIX_ADAPTER_EVENT_H
#define UNIX_ADAPTER_EVENT_H

#include <windows.h>
#include <assert.h>

// A manual reset, initially unset event.  Automatically closes on destruction.
class Event {
public:
    Event() {
        m_handle = CreateEventW(NULL, TRUE, FALSE, NULL);
        assert(m_handle != NULL);
    }
    ~Event() {
        CloseHandle(m_handle);
    }
    HANDLE handle() {
        return m_handle;
    }
    void set() {
        BOOL success = SetEvent(m_handle);
        assert(success && "SetEvent failed");
    }
    void reset() {
        BOOL success = ResetEvent(m_handle);
        assert(success && "ResetEvent failed");
    }

private:
    // Do not allow copying the Event object.
    Event(const Event &other);
    Event &operator=(const Event &other);

private:
    HANDLE m_handle;
};

#endif // UNIX_ADAPTER_EVENT_H
