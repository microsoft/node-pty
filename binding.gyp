{
  'conditions': [
    ['OS=="win"', {
      'targets': [
        {
          'target_name': 'conpty',
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'xcode_settings': { 'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7',
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
          'include_dirs' : [
            '<!(node -p "require(\'node-addon-api\').include_dir")'
          ],
          'sources' : [
            'src/win/conpty.cc',
            'src/win/path_util.cc'
          ],
          'libraries': [
            'shlwapi.lib'
          ]
        },
        {
          'target_name': 'conpty_console_list',
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'xcode_settings': { 'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7',
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
          'include_dirs' : [
            '<!(node -p "require(\'node-addon-api\').include_dir")'
          ],
          'sources' : [
            'src/win/conpty_console_list.cc'
          ]
        },
        {
          'target_name': 'pty',
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'xcode_settings': { 'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7',
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
          'include_dirs' : [
            '<!(node -p "require(\'node-addon-api\').include_dir")',
            'deps/winpty/src/include',
          ],
          # Disabled due to winpty
          'msvs_disabled_warnings': [ 4506, 4530 ],
          'dependencies' : [
            'deps/winpty/src/winpty.gyp:winpty-agent',
            'deps/winpty/src/winpty.gyp:winpty',
          ],
          'sources' : [
            'src/win/winpty.cc',
            'src/win/path_util.cc'
          ],
          'libraries': [
            'shlwapi.lib'
          ],
        }
      ]
    }, { # OS!="win"
      'targets': [{
        'target_name': 'pty',
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'xcode_settings': { 'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7',
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
        'include_dirs' : [
          '<!(node -p "require(\'node-addon-api\').include_dir")'
        ],
        'sources': [
          'src/unix/pty.cc'
        ],
        'libraries': [
          '-lutil'
        ],
        'conditions': [
          # http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html
          #   One some systems (at least including Cygwin, Interix,
          #   OSF/1 4 and 5, and Mac OS X) linking with -lutil is not required.
          ['OS=="mac" or OS=="solaris"', {
            'libraries!': [
              '-lutil'
            ]
          }],
          ['OS=="mac"', {
            "cflags+": ["-fvisibility=hidden"],
            "xcode_settings": {
              "OTHER_CPLUSPLUSFLAGS": [
                "-std=c++11",
                "-stdlib=libc++"
              ],
              "OTHER_LDFLAGS": [
                "-stdlib=libc++"
              ],
              "MACOSX_DEPLOYMENT_TARGET":"10.7",
              "GCC_SYMBOLS_PRIVATE_EXTERN": "YES", # -fvisibility=hidden
            }
          }]
        ]
      }]
    }]
  ]
}
