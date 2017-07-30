/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 */

#ifndef NODE_PTY_UTIL_H_
#define NODE_PTY_UTIL_H_

#include "nan.h"

const wchar_t* to_wstring(const v8::String::Utf8Value& str);

#endif  // NODE_PTY_UTIL_H_
