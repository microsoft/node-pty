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

#include <string.h>

#include <algorithm>

#include "EventLoop.h"
#include "NamedPipe.h"
#include "../shared/DebugClient.h"
#include "../shared/StringUtil.h"
#include "../shared/WinptyAssert.h"

NamedPipe::NamedPipe() :
    m_readBufferSize(64 * 1024),
    m_handle(NULL),
    m_inputWorker(NULL),
    m_outputWorker(NULL)
{
}

NamedPipe::~NamedPipe()
{
    closePipe();
}

// Returns true if anything happens (data received, data sent, pipe error).
bool NamedPipe::serviceIo(std::vector<HANDLE> *waitHandles)
{
    const auto kError = ServiceResult::Error;
    const auto kProgress = ServiceResult::Progress;
    if (m_handle == NULL) {
        return false;
    }
    const auto readProgress = m_inputWorker->service();
    const auto writeProgress = m_outputWorker->service();
    if (readProgress == kError || writeProgress == kError) {
        closePipe();
        return true;
    }
    if (m_inputWorker->getWaitEvent() != NULL) {
        waitHandles->push_back(m_inputWorker->getWaitEvent());
    }
    if (m_outputWorker->getWaitEvent() != NULL) {
        waitHandles->push_back(m_outputWorker->getWaitEvent());
    }
    return readProgress == kProgress || writeProgress == kProgress;
}

NamedPipe::IoWorker::IoWorker(NamedPipe *namedPipe) :
    m_namedPipe(namedPipe),
    m_pending(false),
    m_currentIoSize(0)
{
    m_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    ASSERT(m_event != NULL);
}

NamedPipe::IoWorker::~IoWorker()
{
    CloseHandle(m_event);
}

NamedPipe::ServiceResult NamedPipe::IoWorker::service()
{
    ServiceResult progress = ServiceResult::NoProgress;
    if (m_pending) {
        DWORD actual = 0;
        BOOL ret = GetOverlappedResult(m_namedPipe->m_handle, &m_over, &actual, FALSE);
        if (!ret) {
            if (GetLastError() == ERROR_IO_INCOMPLETE) {
                // There is a pending I/O.
                return progress;
            } else {
                // Pipe error.
                return ServiceResult::Error;
            }
        }
        ResetEvent(m_event);
        m_pending = false;
        completeIo(actual);
        m_currentIoSize = 0;
        progress = ServiceResult::Progress;
    }
    DWORD nextSize = 0;
    bool isRead = false;
    while (shouldIssueIo(&nextSize, &isRead)) {
        m_currentIoSize = nextSize;
        DWORD actual = 0;
        memset(&m_over, 0, sizeof(m_over));
        m_over.hEvent = m_event;
        BOOL ret = isRead
                ? ReadFile(m_namedPipe->m_handle, m_buffer, nextSize, &actual, &m_over)
                : WriteFile(m_namedPipe->m_handle, m_buffer, nextSize, &actual, &m_over);
        if (!ret) {
            if (GetLastError() == ERROR_IO_PENDING) {
                // There is a pending I/O.
                m_pending = true;
                return progress;
            } else {
                // Pipe error.
                return ServiceResult::Error;
            }
        }
        ResetEvent(m_event);
        completeIo(actual);
        m_currentIoSize = 0;
        progress = ServiceResult::Progress;
    }
    return progress;
}

// This function is called after CancelIo has returned.  We need to block until
// the I/O operations have completed, which should happen very quickly.
// https://blogs.msdn.microsoft.com/oldnewthing/20110202-00/?p=11613
void NamedPipe::IoWorker::waitForCanceledIo()
{
    if (m_pending) {
        DWORD actual = 0;
        GetOverlappedResult(m_namedPipe->m_handle, &m_over, &actual, TRUE);
        m_pending = false;
    }
}

HANDLE NamedPipe::IoWorker::getWaitEvent()
{
    return m_pending ? m_event : NULL;
}

void NamedPipe::InputWorker::completeIo(DWORD size)
{
    m_namedPipe->m_inQueue.append(m_buffer, size);
}

bool NamedPipe::InputWorker::shouldIssueIo(DWORD *size, bool *isRead)
{
    *isRead = true;
    if (m_namedPipe->isClosed()) {
        return false;
    } else if (m_namedPipe->m_inQueue.size() < m_namedPipe->readBufferSize()) {
        *size = kIoSize;
        return true;
    } else {
        return false;
    }
}

void NamedPipe::OutputWorker::completeIo(DWORD size)
{
    ASSERT(size == m_currentIoSize);
}

bool NamedPipe::OutputWorker::shouldIssueIo(DWORD *size, bool *isRead)
{
    *isRead = false;
    if (!m_namedPipe->m_outQueue.empty()) {
        auto &out = m_namedPipe->m_outQueue;
        const DWORD writeSize = std::min<size_t>(out.size(), kIoSize);
        std::copy(&out[0], &out[writeSize], m_buffer);
        out.erase(0, writeSize);
        *size = writeSize;
        return true;
    } else {
        return false;
    }
}

DWORD NamedPipe::OutputWorker::getPendingIoSize()
{
    return m_pending ? m_currentIoSize : 0;
}

bool NamedPipe::connectToServer(LPCWSTR pipeName)
{
    ASSERT(isClosed());
    HANDLE handle = CreateFileW(
        pipeName,
        GENERIC_READ | GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | FILE_FLAG_OVERLAPPED,
        NULL);
    trace("connection to [%s], handle == %p",
        utf8FromWide(pipeName).c_str(), handle);
    if (handle == INVALID_HANDLE_VALUE)
        return false;
    m_handle = handle;
    m_inputWorker = new InputWorker(this);
    m_outputWorker = new OutputWorker(this);
    return true;
}

size_t NamedPipe::bytesToSend()
{
    auto ret = m_outQueue.size();
    if (m_outputWorker != NULL) {
        ret += m_outputWorker->getPendingIoSize();
    }
    return ret;
}

void NamedPipe::write(const void *data, size_t size)
{
    m_outQueue.append(reinterpret_cast<const char*>(data), size);
}

void NamedPipe::write(const char *text)
{
    write(text, strlen(text));
}

size_t NamedPipe::readBufferSize()
{
    return m_readBufferSize;
}

void NamedPipe::setReadBufferSize(size_t size)
{
    m_readBufferSize = size;
}

size_t NamedPipe::bytesAvailable()
{
    return m_inQueue.size();
}

size_t NamedPipe::peek(void *data, size_t size)
{
    const auto out = reinterpret_cast<char*>(data);
    const size_t ret = std::min(size, m_inQueue.size());
    std::copy(&m_inQueue[0], &m_inQueue[size], out);
    return ret;
}

size_t NamedPipe::read(void *data, size_t size)
{
    size_t ret = peek(data, size);
    m_inQueue.erase(0, ret);
    return ret;
}

std::string NamedPipe::readToString(size_t size)
{
    size_t retSize = std::min(size, m_inQueue.size());
    std::string ret = m_inQueue.substr(0, retSize);
    m_inQueue.erase(0, retSize);
    return ret;
}

std::string NamedPipe::readAllToString()
{
    std::string ret = m_inQueue;
    m_inQueue.clear();
    return ret;
}

void NamedPipe::closePipe()
{
    if (m_handle == NULL)
        return;
    CancelIo(m_handle);
    m_inputWorker->waitForCanceledIo();
    m_outputWorker->waitForCanceledIo();
    delete m_inputWorker;
    delete m_outputWorker;
    CloseHandle(m_handle);
    m_handle = NULL;
    m_inputWorker = NULL;
    m_outputWorker = NULL;
}

bool NamedPipe::isClosed()
{
    return m_handle == NULL;
}
