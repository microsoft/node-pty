{
    # Pass -D VERSION_SUFFIX=<something> to gyp to override the suffix.
    #
    # The winpty.gyp file ignores the BUILD_INFO.txt file, if it exists.

    'variables' : {
        'VERSION_SUFFIX%' : '-dev',
    },
    'target_defaults' : {
        'defines' : [
            'UNICODE',
            '_UNICODE',
            '_WIN32_WINNT=0x0501',
            'NOMINMAX',
            'WINPTY_VERSION=<!(type VERSION.txt)',
            'WINPTY_VERSION_SUFFIX=<(VERSION_SUFFIX)',
            'WINPTY_COMMIT_HASH=<!(shared\GetCommitHash.cmd)',
        ],
    },
    'targets' : [
        {
            'target_name' : 'winpty-agent',
            'type' : 'executable',
            'include_dirs' : [
                'include',
            ],
            'libraries' : [
                '-luser32.lib',
            ],
            'msvs_disabled_warnings': [ 4267, 4244, 4530, 4267, 4800 ],
            'sources' : [
                'agent/Agent.cc',
                'agent/ConsoleFont.cc',
                'agent/ConsoleFont.h',
                'agent/ConsoleInput.cc',
                'agent/ConsoleInput.h',
                'agent/ConsoleLine.cc',
                'agent/ConsoleLine.h',
                'agent/Coord.h',
                'agent/Coord.cc',
                'agent/DsrSender.h',
                'agent/EventLoop.h',
                'agent/EventLoop.cc',
                'agent/LargeConsoleRead.h',
                'agent/LargeConsoleRead.cc',
                'agent/NamedPipe.h',
                'agent/NamedPipe.cc',
                'agent/SmallRect.cc',
                'agent/Terminal.cc',
                'agent/UnicodeEncoding.h',
                'agent/Win32Console.cc',
                'agent/main.cc',
                'shared/AgentMsg.h',
                'shared/Buffer.h',
                'shared/DebugClient.h',
                'shared/DebugClient.cc',
                'shared/OsModule.h',
                'shared/WinptyAssert.h',
                'shared/WinptyAssert.cc',
                'shared/WinptyVersion.h',
                'shared/WinptyVersion.cc',
                'shared/c99_snprintf.h',
                'shared/winpty_wcsnlen.cc',
                'shared/winpty_wcsnlen.h',
            ],
        },
        {
            'target_name' : 'winpty',
            'type' : 'shared_library',
            'include_dirs' : [
                'include',
            ],
            'libraries' : [
                '-luser32.lib',
            ],
            'msvs_disabled_warnings': [ 4267, 4800 ],
            'sources' : [
                'libwinpty/winpty.cc',
                'shared/DebugClient.cc',
            ],
        },
        {
            'target_name' : 'winpty-debugserver',
            'type' : 'executable',
            'sources' : [
                'debugserver/DebugServer.cc',
            ],
        }
    ],
}
