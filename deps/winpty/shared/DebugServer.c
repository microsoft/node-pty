#include <windows.h>
#include <tchar.h>
#include <strsafe.h>
#include <stdio.h>
#include <string.h>

const int MSG_SIZE = 4096;
const LPCWSTR DEBUG_PIPE_NAME = L"\\\\.\\pipe\\DebugServer";
/*
static bool connectPipeChannel() {
	HANDLE handle = CreateFile(DEBUG_PIPE_NAME,
                               GENERIC_READ | GENERIC_WRITE,
                               0,
                               NULL,
                               OPEN_EXISTING,
                               FILE_FLAG_OVERLAPPED,
                               NULL);
	return handle != INVALID_HANDLE_VALUE;
};

// Call ConnectNamedPipe and block, even for an overlapped pipe.  If the
// pipe is overlapped, create a temporary event for use connecting.
static bool connectNamedPipe(HANDLE handle, bool overlapped)
{
    OVERLAPPED over, *pover = NULL;
    if (overlapped) {
        pover = &over;
        memset(&over, 0, sizeof(over));
        over.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
    }
    bool success = ConnectNamedPipe(handle, pover);
    if (overlapped && !success && GetLastError() == ERROR_IO_PENDING) {
        DWORD actual;
        success = GetOverlappedResult(handle, pover, &actual, TRUE);
    }
    if (!success && GetLastError() == ERROR_PIPE_CONNECTED)
        success = TRUE;
    if (overlapped)
        CloseHandle(over.hEvent);
    return success;
};

DWORD WINAPI foreverThread(LPVOID lpParam) {
	
	printf("Listening for debug information.\n");

	// Create our debug pipe
	HANDLE debugPipe = CreateNamedPipe(
		DEBUG_PIPE_NAME,
		PIPE_ACCESS_DUPLEX,
		PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE,
		PIPE_UNLIMITED_INSTANCES,
		MSG_SIZE,
		MSG_SIZE,
		10 * 1000,
		NULL);

	// Wtf
	if(debugPipe == INVALID_HANDLE_VALUE) {
		printf("Unable to create named pipe");
		ExitProcess(-1);
	}

	// Loop forever
	while(true) {
		
		// Connect to the pipe
		if(!connectNamedPipe(debugPipe, true)) {
			// Try waiting 
			printf("Unable to connect to debug pipe %s", DEBUG_PIPE_NAME);
			Sleep(100);
			continue;
		}
	
	
	}

};*/

/**
* 
*/
DWORD WINAPI foreverThread(LPVOID lpParam) { 
	printf("Created thread");
	while(TRUE) {
		Sleep(100);
	}
};

/**
* If Agent is running in debug mode all the debug information
* is transmitted via a named pipe. This program will display debug
* information for all running ptys.
*/
int main(int argc, char **argv) {
	
    DWORD   dwThreadId;
    HANDLE  hThread;
	
	hThread = CreateThread( 
            NULL,                 
            0,                      
            foreverThread,     
            NULL,          
            0,                     
            &dwThreadId); 

	if(dwThreadId == NULL) {
		printf("Unable to create thread");
		ExitProcess(-1);
	}
	
	WaitForSingleObject(hThread, INFINITE);
	CloseHandle(hThread);

	return 0;
}