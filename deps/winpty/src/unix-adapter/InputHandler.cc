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

#include "InputHandler.h"

#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <sys/select.h>
#include <unistd.h>

#include <algorithm>
#include <vector>

#include "../shared/DebugClient.h"
#include "Event.h"
#include "Util.h"
#include "WakeupFd.h"

InputHandler::InputHandler(HANDLE winpty, WakeupFd &completionWakeup) :
    m_winpty(winpty),
    m_completionWakeup(completionWakeup),
    m_threadHasBeenJoined(false),
    m_shouldShutdown(0),
    m_threadCompleted(0)
{
    assert(isatty(STDIN_FILENO));
    pthread_create(&m_thread, NULL, InputHandler::threadProcS, this);
}

void InputHandler::shutdown() {
    startShutdown();
    if (!m_threadHasBeenJoined) {
        int ret = pthread_join(m_thread, NULL);
        assert(ret == 0 && "pthread_join failed");
        m_threadHasBeenJoined = true;
    }
}

void InputHandler::threadProc() {
    Event ioEvent;
    std::vector<char> buffer(4096);
    fd_set readfds;
    FD_ZERO(&readfds);
    while (true) {
        // Handle shutdown.
        m_wakeup.reset();
        if (m_shouldShutdown) {
            trace("InputHandler: shutting down");
            break;
        }

        // Block until data arrives.
        {
            const int max_fd = std::max(STDIN_FILENO, m_wakeup.fd());
            FD_SET(STDIN_FILENO, &readfds);
            FD_SET(m_wakeup.fd(), &readfds);
            selectWrapper("InputHandler", max_fd + 1, &readfds);
            if (!FD_ISSET(STDIN_FILENO, &readfds)) {
                continue;
            }
        }

        const int numRead = read(STDIN_FILENO, &buffer[0], buffer.size());
        if (numRead == -1 && errno == EINTR) {
            // Apparently, this read is interrupted on Cygwin 1.7 by a SIGWINCH
            // signal even though I set the SA_RESTART flag on the handler.
            continue;
        }

        // tty is closed, or the read failed for some unexpected reason.
        if (numRead <= 0) {
            trace("InputHandler: tty read failed: numRead=%d", numRead);
            break;
        }

        DWORD written;
        OVERLAPPED over = {0};
        over.hEvent = ioEvent.handle();
        BOOL ret = WriteFile(m_winpty,
                             &buffer[0], numRead,
                             &written,
                             &over);
        if (!ret && GetLastError() == ERROR_IO_PENDING) {
            const HANDLE handles[] = {
                ioEvent.handle(),
                m_wakeup.handle(),
            };
            const DWORD waitRet =
                WaitForMultipleObjects(2, handles, FALSE, INFINITE);
            if (waitRet == WAIT_OBJECT_0 + 1) {
                trace("InputHandler: shutting down, canceling I/O");
                assert(m_shouldShutdown);
                CancelIo(m_winpty);
                break;
            }
            assert(waitRet == WAIT_OBJECT_0);
            ret = GetOverlappedResult(m_winpty, &over, &written, TRUE);
        }
        if (!ret || written != static_cast<DWORD>(numRead)) {
            if (!ret && GetLastError() == ERROR_BROKEN_PIPE) {
                trace("InputHandler: pipe closed: written=%u",
                    static_cast<unsigned int>(written));
            } else {
                trace("InputHandler: write failed: "
                    "ret=%d lastError=0x%x numRead=%d written=%u",
                    ret,
                    static_cast<unsigned int>(GetLastError()),
                    numRead,
                    static_cast<unsigned int>(written));
            }
            break;
        }
    }
    m_threadCompleted = 1;
    m_completionWakeup.set();
}
