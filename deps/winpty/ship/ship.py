#!python

# Copyright (c) 2015 Ryan Prichard
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to
# deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
# sell copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
# IN THE SOFTWARE.

#
# Run with native CPython 2 on a 64-bit computer.  The pip package, "pefile",
# must be installed.
#
# Each of the targets in BUILD_TARGETS must be installed to the default
# location.  Each target must have the appropriate MinGW and non-MinGW
# compilers installed, as well as make and tar.
#

import os
import pefile
import shutil
import subprocess

# Ensure that we're in the root directory.
if not os.path.exists("VERSION.txt"):
    os.chdir("..")
with open("VERSION.txt", "rt") as f:
    VERSION = f.read().strip()

# Check other environment considerations
if os.name != "nt":
    sys.exit("Error: ship.py should run in a native CPython.")
if os.environ.get("SHELL") is not None:
    sys.exit("Error: ship.py should run outside a Cygwin environment.")

def dllVersion(path):
    pe = pefile.PE(path)
    ret = None
    for fi in pe.FileInfo:
        if fi.Key != "StringFileInfo":
            continue
        for st in fi.StringTable:
            ret = st.entries.get("FileVersion")
            break
    assert ret is not None
    return ret

# Determine other build parameters.
print "Determining Cygwin/MSYS2 DLL versions..."
COMMIT_HASH = subprocess.check_output(["git.exe", "rev-parse", "HEAD"]).decode().strip()
BUILD_TARGETS = [
    {
        "name": "cygwin-" + dllVersion("C:\\cygwin\\bin\\cygwin1.dll") + "-ia32",
        "path": "C:\\cygwin\\bin",
    },
    {
        "name": "cygwin-" + dllVersion("C:\\cygwin64\\bin\\cygwin1.dll") + "-x64",
        "path": "C:\\cygwin64\\bin",
    },
    {
        "name": "msys2-" + dllVersion("C:\\msys32\\usr\\bin\\msys-2.0.dll") + "-ia32",
        "path": "C:\\msys32\\mingw32\\bin;C:\\msys32\\usr\\bin",
    },
    {
        "name": "msys2-" + dllVersion("C:\\msys64\\usr\\bin\\msys-2.0.dll") + "-x64",
        "path": "C:\\msys64\\mingw64\\bin;C:\\msys64\\usr\\bin",
    },
    {
        "name": "msys",
        "path": "C:\\MinGW\\bin;C:\\MinGW\\msys\\1.0\\bin",
        # The parallel make in the original MSYS/MinGW project hangs.
        "allow_parallel_make": False,
    },
]

def writeBuildInfo():
    with open("BUILD_INFO.txt", "w") as f:
        f.write("VERSION_SUFFIX=\n")
        f.write("COMMIT_HASH=" + COMMIT_HASH + "\n")

def buildTarget(target):
    packageName = "winpty-" + VERSION + "-" + target["name"]
    oldPath = os.environ["PATH"]
    os.environ["PATH"] = target["path"] + ";" + oldPath
    subprocess.check_call(["sh.exe", "configure"])
    subprocess.check_call(["make.exe", "clean"])
    buildArgs = ["make.exe", "all", "tests"]
    if target.get("allow_parallel_make", True):
        buildArgs += ["-j8"]
    subprocess.check_call(buildArgs)
    subprocess.check_call(["build\\trivial_test.exe"])
    subprocess.check_call(["make.exe", "PREFIX=ship\\packages\\" + packageName, "install"])
    subprocess.check_call(["tar.exe", "cvfz",
        packageName + ".tar.gz",
        packageName], cwd=os.path.join(os.getcwd(), "ship", "packages"))
    shutil.rmtree("ship\\packages\\" + packageName)
    os.environ["PATH"] = oldPath

def main():
    try:
        writeBuildInfo()
        if os.path.exists("ship\\packages"):
            shutil.rmtree("ship\\packages")
        oldPath = os.environ["PATH"]
        for t in BUILD_TARGETS:
            os.environ["PATH"] = t["path"] + ";" + oldPath
            subprocess.check_output(["tar.exe", "--help"])
            subprocess.check_output(["make.exe", "--help"])
        for t in BUILD_TARGETS:
            buildTarget(t)
    finally:
        os.remove("BUILD_INFO.txt")

if __name__ == "__main__":
    main()
