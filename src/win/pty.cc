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

static winpty_t *agentPty;
static volatile LONG ptyCounter;

/**
* Helpers
*/
const char* ToCString(const v8::String::Utf8Value& value) {
  return *value ? *value : "<string conversion failed>";
}

/*
* PtyOpen
* pty.open(controlPipe, dataPipe, cols, rows)
*/

static Handle<Value> PtyOpen(const Arguments& args) {
	HandleScope scope;

	if (args.Length() != 4
		|| !args[0]->IsString() // controlPipe
		|| !args[1]->IsString() // dataPipe
		|| !args[2]->IsNumber() // cols
		|| !args[3]->IsNumber()) // rows
	{
			return ThrowException(Exception::Error(
				String::New("Usage: pty.open(controlPipe, dataPipe, cols, rows)")));
	}

	// Cols, rows
	int cols = (int) args[2]->Int32Value();
	int rows = (int) args[3]->Int32Value();
	
	// Controlpipe
	String::Utf8Value controlPipe(args[0]->ToString());
	String::Utf8Value dataPipe(args[1]->ToString());

	// If successfull the PID of the agent process will be returned.
	int * agentPty = winpty_open_ptyjs(ToCString(controlPipe), ToCString(dataPipe), rows, cols);
	
	// Error occured during startup of agent process
	if(agentPty == NULL) {
		return ThrowException(Exception::Error(String::New("Unable to start agent process")));
	}

	// Pty object values
	Local<Object> obj = Object::New();
	
	// Agent pid
	obj->Set(String::New("pid"), Number::New((int)agentPty));

	// File descriptor (Not available on windows).
	obj->Set(String::New("fd"), Number::New(-1));
	
	// Some peepz use this as an id, lets give em one.
	obj->Set(String::New("pty"), Number::New(InterlockedIncrement(&ptyCounter)));
	

	return scope.Close(obj);
	
}

/**
* Init
*/

extern "C" void init(Handle<Object> target) {
	HandleScope scope;
	NODE_SET_METHOD(target, "open", PtyOpen);
};

NODE_MODULE(pty, init);
