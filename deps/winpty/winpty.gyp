{
    'targets' : [
        {
            'target_name' : 'winpty-agent',
            'type' : 'executable',
            'include_dirs' : [
                'include',
            ],
			'libraries' : [
				'user32.lib'
			],
            'defines' : [
                'UNICODE',
                '_UNICODE',
                '_WIN32_WINNT=0x0501',
                'NOMINMAX',
            ],
            'msvs_disabled_warnings': [ 4267, 4244, 4530, 4267, 4800 ],
            'sources' : [
                'agent/Agent.cc',
                'agent/AgentAssert.cc',
                'agent/ConsoleFont.cc',
                'agent/ConsoleFont.h',
                'agent/ConsoleInput.cc',
                'agent/ConsoleInput.h',
                'agent/ConsoleLine.cc',
                'agent/ConsoleLine.h',
                'agent/Coord.h',
                'agent/Coord.cc',
                'agent/EventLoop.cc',
                'agent/NamedPipe.cc',
                'agent/SmallRect.cc',
                'agent/Terminal.cc',
                'agent/UnicodeEncoding.h',
                'agent/Win32Console.cc',
                'agent/main.cc',
                'agent/winpty_wcsnlen.cc',
                'agent/winpty_wcsnlen.h',
                'shared/AgentMsg.h',
                'shared/Buffer.h',
                'shared/DebugClient.h',
                'shared/DebugClient.cc',
            ],
        },
        {
            'target_name' : 'winpty',
            'type' : 'shared_library',
            'include_dirs' : [
                'include',
            ],
			'libraries' : [
				'user32.lib'
			],
            'defines' : [
                'UNICODE',
                '_UNICODE',
                '_WIN32_WINNT=0x0501',
                'NOMINMAX',
                'WINPTY',
            ],
            'msvs_disabled_warnings': [ 4267, 4800 ],
            'sources' : [
                'libwinpty/winpty.cc',
                'shared/DebugClient.cc',
            ],
        },
    ],
}
