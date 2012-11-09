/**
* pty.js
* Copyright (c) 2012, Christopher Jeffrey, Peter Sunde (MIT License)
*
* pty.cc:
*   This file is responsible for starting processes
*   with pseudo-terminal file descriptors.
*/

#include <v8.h>
#include <node.h>
#include <uv.h>
#include <node_buffer.h>
#include <string.h>
#include <stdlib.h>
#include <winpty.h>
#include <string>

using namespace v8;
using namespace std;
using namespace node;

extern "C" void init(Handle<Object>);

/**
* Conversion
*/
template <typename dataType>
void GetBuffer(dataType &ref, Local<Object> buff){
	if (Buffer::HasInstance(buff)) {
		ref = reinterpret_cast<dataType>(Buffer::Data(buff));
	}
}

/**
* Globals
*/
static winpty_t *agentPty;
static volatile LONG ptyCounter;

/*
*  WinPTY
*/

struct winpty_s {
	winpty_s();
	HANDLE controlPipe;
	HANDLE dataPipe;
	wstring controlPipeName; 
	wstring dataPipeName; 
	int pid;
};

winpty_s::winpty_s() : controlPipe(NULL), dataPipe(NULL)
{
}

static bool connectNamedPipe(HANDLE handle, bool overlapped)
{
    OVERLAPPED over, *pover = NULL;
    if (overlapped) {
        pover = &over;
        memset(&over, 0, sizeof(over));
        over.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
        assert(over.hEvent != NULL);
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
}

/**
* PtyFork
* pty.fork(file, args, env, cwd, cols, rows)
*/

static Handle<Value> PtyFork(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 6
		|| !args[0]->IsString()
		|| !args[1]->IsArray()
		|| !args[2]->IsArray()
		|| !args[3]->IsString()
		|| !args[4]->IsNumber()
		|| !args[5]->IsNumber()) {
			return ThrowException(Exception::Error(
				String::New("Usage: pty.fork(file, args, env, cwd, cols, rows)")));
	}

	// Cols, rows
	int rows = (int) args[4]->Int32Value();
	int cols = (int) args[5]->Int32Value();

	// Start the agent process
	agentPty = winpty_open(rows, cols);
	
	// Error occured during startup of agent process
	if(agentPty == NULL) {
		return ThrowException(Exception::Error(String::New("Unable to start agent process")));
	}
	
	// Filename
	String::Utf8Value file(args[0]->ToString());

	// Arguments
	int i = 0;
	Local<Array> argv_ = Local<Array>::Cast(args[1]);
	int argc = argv_->Length();
	int argl = argc + 1 + 1;
	char **argv = new char*[argl];
	argv[0] = strdup(*file);
	argv[argl-1] = NULL;
	for (; i < argc; i++) {
		String::Utf8Value arg(argv_->Get(Integer::New(i))->ToString());
		argv[i+1] = strdup(*arg);
	}

	// Environment
	i = 0;
	Local<Array> env_ = Local<Array>::Cast(args[2]);
	int envc = env_->Length();
	char **env = new char*[envc+1];
	env[envc] = NULL;
	for (; i < envc; i++) {
		String::Utf8Value pair(env_->Get(Integer::New(i))->ToString());
		env[i] = strdup(*pair);
	}

	// Check if starting a new pty was successfull
	int ret = winpty_start_process(agentPty, L"", L"cmd.exe", L"C:\\", L"");

	// Agent process was started succesfully, but unable to fork pty
	if(ret != 0) {
		return ThrowException(Exception::Error(String::New("Unable to fork pty")));
	}

	// Return values
	Local<Object> obj = Object::New();

	// Node.js does not support handling file descriptors on windows, so 
	// we just increment the number of ptys that has been forked
	obj->Set(String::New("fd"), Number::New(InterlockedIncrement(&ptyCounter)));

	// Expose see pipes
	string controlPipeName(agentPty->controlPipeName.begin(), agentPty->controlPipeName.end());
	string dataPipeName(agentPty->dataPipeName.begin(), agentPty->dataPipeName.end());
	obj->Set(String::New("controlPipe"), String::New(controlPipeName.c_str()));
	obj->Set(String::New("dataPipe"), String::New(dataPipeName.c_str()));

	// Process id of forked terminal
	obj->Set(String::New("pid"), Number::New(winpty_get_process_id(agentPty)));

	// Process id of agent (killing this process will kill all forked terminals)
	obj->Set(String::New("agent_pid"), Number::New(agentPty->pid));

	// Good luck with that, sir.
	obj->Set(String::New("pty"), Undefined());

	return scope.Close(obj);
}

/**
* PtyOpen
* pty.open(cols, rows)
*/

static Handle<Value> PtyOpen(const Arguments& args) {
	HandleScope scope;

	return ThrowException(Exception::Error(
		String::New("Open() is not supported on Windows. Use Fork() instead.")));
}

/**
* Resize Functionality
* pty.resize(fd, cols, rows)
*/

static Handle<Value> PtyResize(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 3
		|| !args[0]->IsNumber()
		|| !args[1]->IsNumber()
		|| !args[2]->IsNumber()) {
			return ThrowException(Exception::Error(
				String::New("Usage: pty.resize(fd, cols, rows)")));
	}

	return Undefined();
}

/**
* PtyGetProc
* Foreground Process Name
* pty.process(fd, tty)
*/

static Handle<Value> PtyGetProc(const Arguments& args) {
	HandleScope scope;

	return ThrowException(Exception::Error(
		String::New("GetProc() is not supported on Windows.")));

}

/**
* Init
*/

extern "C" void init(Handle<Object> target) {
	HandleScope scope;
	NODE_SET_METHOD(target, "fork", PtyFork);
	NODE_SET_METHOD(target, "open", PtyOpen);
	NODE_SET_METHOD(target, "resize", PtyResize);
	NODE_SET_METHOD(target, "process", PtyGetProc);
};

NODE_MODULE(pty, init);