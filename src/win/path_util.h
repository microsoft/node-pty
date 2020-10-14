/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 *
 * Ported to N-API by Matthew Denninghoff and David Russo
 * Reference: https://github.com/nodejs/node-addon-api
 *
 */

#ifndef NODE_PTY_PATH_UTIL_H_
#define NODE_PTY_PATH_UTIL_H_

#include <napi.h>

#define MAX_ENV 65536

namespace path_util {

std::wstring to_wstring(const Napi::String& str);
bool file_exists(std::wstring filename);
std::wstring get_shell_path(std::wstring filename);

}  // namespace path_util

#endif  // NODE_PTY_PATH_UTIL_H_
