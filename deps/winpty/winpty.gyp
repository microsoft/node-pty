{
	'targets' : [
		{
			'target_name' : 'winpty-agent',
			'type' : 'executable',
			'include_dirs' : [
				'include',
				'agent',
				'shared',
			],
			'defines' : [
				'UNICODE',
				'_UNICODE',
				'_WIN32_WINNT=0x0501',
				'NOMINMAX'
			],
			'sources' : [
				'agent/Agent.h',
				'agent/Agent.cc',
				'agent/AgentAssert.h',
				'agent/AgentAssert.cc',
				'agent/AgentDebugClient.cc',
				'agent/ConsoleInput.cc',
				'agent/ConsoleInput.h',
				'agent/Coord.h',
				'agent/Coord.cc',
				'agent/DsrSender.h',
				'agent/EventLoop.cc',
				'agent/main.cc',
				'agent/NamedPipe.h',
				'agent/NamedPipe.cc',
				'agent/SmallRect.h',
				'agent/SmallRect.cc',
				'agent/Terminal.h',
				'agent/Terminal.cc',
				'agent/Win32Console.cc',
				'agent/Win32Console.h',
				'shared/AgentMsg.h',
				'shared/Buffer.h',
				'shared/DebugClient.h',
				'shared/DebugClient.cc'
			]
		},		
		{
			'target_name' : 'libwinpty',
			'type' : 'shared_library',
			'include_dirs' : [
				'include',
				'agent',
				'shared',	
				'libwinpty'
			],
			'defines' : [
				'UNICODE',
				'_UNICODE',
				'_WIN32_WINNT=0x0501',
				'WINPTY',
			],
			'sources' : [
				'libwinpty/winpty.cc',
				'shared/DebugClient.cc'
			],
			'link_settings' : {
				'libraries' : [
					'-Llibwinpty.lib'
				]
			}
		}
	]
}