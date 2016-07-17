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

#include "OutputHandler.h"

#include <assert.h>
#include <errno.h>
#include <sys/select.h>
#include <unistd.h>

#include <algorithm>
#include <vector>

#include "../shared/DebugClient.h"
#include "Event.h"
#include "Util.h"
#include "WakeupFd.h"

OutputHandler::OutputHandler(HANDLE winpty, WakeupFd &completionWakeup) :
    m_winpty(winpty),
    m_completionWakeup(completionWakeup),
    m_threadHasBeenJoined(false),
    m_shouldShutdown(0),
    m_threadCompleted(0)
{
    assert(isatty(STDOUT_FILENO));
    pthread_create(&m_thread, NULL, OutputHandler::threadProcS, this);
}

void OutputHandler::shutdown() {
    startShutdown();
    if (!m_threadHasBeenJoined) {
        int ret = pthread_join(m_thread, NULL);
        assert(ret == 0 && "pthread_join failed");
        m_threadHasBeenJoined = true;
    }
}

void OutputHandler::threadProc() {
    Event ioEvent;
    std::vector<char> buffer(4096);
    while (true) {
        // Handle shutdown
        m_wakeup.reset();
        if (m_shouldShutdown) {
            trace("OutputHandler: shutting down");
            break;
        }

        // Read from the pipe.
        DWORD numRead;
        OVERLAPPED over = {0};
        over.hEvent = ioEvent.handle();
        BOOL ret = ReadFile(m_winpty,
                            &buffer[0], buffer.size(),
                            &numRead,
                            &over);
        if (!ret && GetLastError() == ERROR_IO_PENDING) {
            const HANDLE handles[] = {
                ioEvent.handle(),
                m_wakeup.handle(),
            };
            const DWORD waitRet =
                WaitForMultipleObjects(2, handles, FALSE, INFINITE);
            if (waitRet == WAIT_OBJECT_0 + 1) {
                trace("OutputHandler: shutting down, canceling I/O");
                assert(m_shouldShutdown);
                CancelIo(m_winpty);
                break;
            }
            assert(waitRet == WAIT_OBJECT_0);
            ret = GetOverlappedResult(m_winpty, &over, &numRead, TRUE);
        }
        if (!ret || numRead == 0) {
            if (!ret && GetLastError() == ERROR_BROKEN_PIPE) {
                trace("OutputHandler: pipe closed: numRead=%u",
                    static_cast<unsigned int>(numRead));
            } else {
                trace("OutputHandler: read failed: "
                    "ret=%d lastError=0x%x numRead=%u",
                    ret,
                    static_cast<unsigned int>(GetLastError()),
                    static_cast<unsigned int>(numRead));
            }
            break;
        }
        if (!writeAll(STDOUT_FILENO, &buffer[0], numRead)) {
            break;
        }
    }
    m_threadCompleted = 1;
    m_completionWakeup.set();
}
