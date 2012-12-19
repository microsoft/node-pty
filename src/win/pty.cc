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
#include <node_buffer.h>
#include <string.h>
#include <stdlib.h>
#include <winpty.h>
#include <string>
#include <sstream>
#include <iostream>
#include <vector>

using namespace v8;
using namespace std;
using namespace node;

/**
* Misc
*/
extern "C" void init(Handle<Object>);

static winpty_t *agentPty;
static std::vector<winpty_t *> ptyHandles;
static volatile LONG ptyCounter;

struct winpty_s {
	winpty_s();
	HANDLE controlPipe;
	HANDLE dataPipe;
	int pid;
};

winpty_s::winpty_s() : controlPipe(NULL), dataPipe(NULL)
{
}

/**
* Helpers
*/

wchar_t* ToWChar(const char* utf8){
	if (utf8 == NULL || *utf8 == L'\0') {
		return new wchar_t[0];
	} else {
		const int utf8len = static_cast<int>(strlen(utf8));
		const int utf16len = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, utf8len, NULL, 0);
		if (utf16len == 0) {
			return new wchar_t[0];
		} else {
			wchar_t* utf16 = new wchar_t[utf16len];
			if (!::MultiByteToWideChar(CP_UTF8, 0, utf8, utf8len, utf16, utf16len)) {
				return new wchar_t[0];
			} else {
				return utf16;
			}
		}
	}
}

const char* ToCString(const v8::String::Utf8Value& value) {
	return *value ? *value : "<string conversion failed>";
}

template <typename T>
void remove(std::vector<T>& vec, size_t pos)
{
	std::vector<T>::iterator it = vec.begin();
	std::advance(it, pos);
	vec.erase(it);
}

// Find a given pipe handle by using agent pid
static winpty_t *getControlPipeHandle(int pid) {
	for(unsigned int i = 0; i < ptyHandles.size(); i++) {
		winpty_t *ptyHandle = ptyHandles[i];
		if(ptyHandle->pid == pid) {
			return ptyHandle;
		}
	}
	return NULL;
}

// Remove a given pipe handle
static bool removePipeHandle(int pid) {
	for(unsigned int i = 0; i < ptyHandles.size(); i++) {
		winpty_t *ptyHandle = ptyHandles[i];
		if(ptyHandle->pid == pid) {
			remove(ptyHandles, i);
			return true;
		}
	}
	return false;
}

/*
* PtyOpen
* pty.open(controlPipe, dataPipe, cols, rows)
*  
* Steps for debugging agent.exe:
* 
* 1) Open a windows terminal
* 2) set WINPTYDBG=1
* 3) python deps/misc/DebugServer.py
* 4) Start a new terminal in node.js and trace output will appear
*    in the python script.
* 
*/

static Handle<Value> PtyOpen(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 5
		|| !args[0]->IsString() // controlPipe
		|| !args[1]->IsString() // dataPipe
		|| !args[2]->IsNumber() // cols
		|| !args[3]->IsNumber() // rows
		|| !args[4]->IsBoolean()) // debug
	{
		return ThrowException(Exception::Error(
			String::New("Usage: pty.open(controlPipe, dataPipe, cols, rows, debug)")));
	}

	// Cols, rows
	bool debug = (bool) args[4]->BooleanValue;
	int cols = (int) args[2]->Int32Value();
	int rows = (int) args[3]->Int32Value();

	// If debug is enabled, set environment variable
	if(debug) {
		SetEnvironmentVariableW(L"WINPTYDBG", L"1");
	} else {
		FreeEnvironmentStringsW(L"WINPTYDBG");
	}

	// Controlpipe
	String::Utf8Value controlPipe(args[0]->ToString());
	String::Utf8Value dataPipe(args[1]->ToString());

	// If successfull the PID of the agent process will be returned.
	agentPty = winpty_open_ptyjs(ToCString(controlPipe), ToCString(dataPipe), rows, cols);

	// Error occured during startup of agent process
	if(agentPty == NULL) {
		return ThrowException(Exception::Error(String::New("Unable to start agent process.")));
	}

	// Save a copy of this pty so that we can find the control socket handle
	// later on.
	ptyHandles.insert(ptyHandles.end(), agentPty);

	// Pty object values
	Local<Object> obj = Object::New();

	// Agent pid
	obj->Set(String::New("pid"), Number::New(agentPty->pid));

	// Use handle of control pipe as our file descriptor
	obj->Set(String::New("fd"), Number::New(-1));

	// Some peepz use this as an id, lets give em one.
	obj->Set(String::New("pty"), Number::New(InterlockedIncrement(&ptyCounter)));

	return scope.Close(obj);

}

/*
* PtyStartProcess
* pty.startProcess(pid, file, env, cwd);
*/

static Handle<Value> PtyStartProcess(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 4
		|| !args[0]->IsNumber() // pid
		|| !args[1]->IsString() // file + args
		|| !args[2]->IsString() // env
		|| !args[3]->IsString()) // cwd
	{
		return ThrowException(Exception::Error(
			String::New("Usage: pty.open(pid, file, env, cwd)")));
	}

	// Native values
	int pid = (int) args[0]->Int32Value();

	// convert to wchar_t
	std::wstring file(ToWChar(*String::Utf8Value(args[1]->ToString())));
	std::wstring env(ToWChar(*String::Utf8Value(args[2]->ToString())));

	// Okay this is really fucked up. What the hell is going and
	// why does not ToWChar work? Windows reports error code 267
	// if ToWChar is used. Could somebody please elaborate on this? :)
	std::string _cwd((*String::Utf8Value(args[3]->ToString())));
	std::wstring cwd(_cwd.begin(), _cwd.end());

	// Cwd must be double slash encoded otherwise
	// we fail to start the terminal process and get
	// windows error code 267.
	for (int i = 0; i < cwd.length(); ++i) {
		if (cwd[i] == '\\') {
			cwd.insert(i, 1, '\\');
			++i; // Skip inserted char
		}
	}

	// Get pipe handle
	winpty_t *pc = getControlPipeHandle(pid);

	// Start new terminal
	if(pc != NULL) {
		winpty_start_process(pc, NULL, file.c_str(), cwd.c_str(), env.c_str());		
	} else {
		return ThrowException(Exception::Error(
			String::New("Invalid pid.")));
	}

	return scope.Close(Undefined());
}

/*
* PtyResize
* pty.resize(pid, cols, rows);
*/
static Handle<Value> PtyResize(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 3
		|| !args[0]->IsNumber() // pid
		|| !args[1]->IsNumber() // cols
		|| !args[2]->IsNumber()) // rows
	{
		return ThrowException(Exception::Error(
			String::New("Usage: pty.resize(pid, cols, rows)")));
	}

	int pid = (int) args[0]->Int32Value();
	int cols = (int) args[1]->Int32Value();
	int rows = (int) args[2]->Int32Value();

	winpty_t *pc = getControlPipeHandle(pid);

	if(pc == NULL) {
		return ThrowException(Exception::Error(
			String::New("Invalid pid.")));
	}

	winpty_set_size(pc, cols, rows);

	return scope.Close(Undefined());
}

/*
* PtyKill
* pty.kill(pid);
*/
static Handle<Value> PtyKill(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 1
		|| !args[0]->IsNumber()) // pid
	{
		return ThrowException(Exception::Error(
			String::New("Usage: pty.kill(pid)")));
	}

	int pid = (int) args[0]->Int32Value();

	winpty_t *pc = getControlPipeHandle(pid);

	if(pc == NULL) {
		return ThrowException(Exception::Error(
			String::New("Invalid pid.")));
	}

	winpty_close(pc);

	removePipeHandle(pid);

	return scope.Close(Undefined());

}

/**
* Init
*/

extern "C" void init(Handle<Object> target) {
	HandleScope scope;
	NODE_SET_METHOD(target, "open", PtyOpen);
	NODE_SET_METHOD(target, "startProcess", PtyStartProcess);
	NODE_SET_METHOD(target, "resize", PtyResize);
	NODE_SET_METHOD(target, "kill", PtyKill);
};

NODE_MODULE(pty, init);
