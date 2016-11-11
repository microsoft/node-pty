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

#ifndef UNIX_ADAPTER_DUAL_WAKEUP_H
#define UNIX_ADAPTER_DUAL_WAKEUP_H

#include "Event.h"
#include "WakeupFd.h"

class DualWakeup {
public:
    void set() {
        m_event.set();
        m_wakeupfd.set();
    }
    void reset() {
        m_event.reset();
        m_wakeupfd.reset();
    }
    HANDLE handle() {
        return m_event.handle();
    }
    int fd() {
        return m_wakeupfd.fd();
    }

private:
    Event m_event;
    WakeupFd m_wakeupfd;
};

#endif // UNIX_ADAPTER_DUAL_WAKEUP_H
