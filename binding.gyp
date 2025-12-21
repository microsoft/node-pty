{
  'target_defaults': {
    'dependencies': [
      "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
    ],
    'conditions': [
      ['OS=="win"', {
        'msvs_configuration_attributes': {
          'SpectreMitigation': 'Spectre'
        },
        'msvs_settings': {
            'VCCLCompilerTool': {
              'AdditionalOptions': [
                '/guard:cf',
                '/sdl',
                '/W3',
                '/w34244',
                '/w34267',
                '/ZH:SHA_256'
              ]
            },
            'VCLinkerTool': {
              'AdditionalOptions': [
                '/DYNAMICBASE',
                '/guard:cf'
              ]
            }
          },
      }],
    ],
  },
  'conditions': [
    ['OS=="win"', {
      'targets': [
        {
          'target_name': 'conpty',
          'sources' : [
            'src/win/conpty.cc',
            'src/win/path_util.cc'
          ],
          'libraries': [
            '-lshlwapi'
          ],
        },
        {
          'target_name': 'conpty_console_list',
          'sources' : [
            'src/win/conpty_console_list.cc'
          ],
        },
        {
          'target_name': 'pty',
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
            '-lshlwapi'
          ],
        }
      ]
    }, { # OS!="win"
      'targets': [
        {
          'target_name': 'pty',
          'sources': [
            'src/unix/pty.cc',
          ],
          'libraries': [
            '-lutil'
          ],
          'cflags': ['-Wall', '-O2', '-D_FORTIFY_SOURCE=2'],
          'conditions': [
            # http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html
            #   One some systems (at least including Cygwin, Interix,
            #   OSF/1 4 and 5, and Mac OS X) linking with -lutil is not required.
            ['OS=="mac" or OS=="solaris"', {
              'libraries!': [
                '-lutil'
              ]
            }]
          ]
        }
      ]
    }],
    ['OS=="mac"', {
      'targets': [
        {
          'target_name': 'spawn-helper',
          'type': 'executable',
          'sources': [
            'src/unix/spawn-helper.cc',
          ],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET":"10.7"
          }
        },
      ]
    }]
  ]
}
