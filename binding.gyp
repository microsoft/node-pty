{
  'targets': [{
    'target_name': 'pty',
	'type' : 'loadable_module',
    'conditions': [
      # http://www.gnu.org/software/gnulib/manual/html_node/forkpty.html
      #   One some systems (at least including Cygwin, Interix,
      #   OSF/1 4 and 5, and Mac OS X) linking with -lutil is not required.
      ['OS=="mac" or OS=="solaris" or OS=="linux"', {
        'libraries!': [
          '-lutil'
        ],
		'sources': [
			'src/unix/pty.cc'
		],
      }],
	  ['OS=="win"', {
		'include_dirs' : [
			'deps/winpty/include',
		],
		'dependencies' : [
			'deps/winpty/winpty.gyp:agent',
			'deps/winpty/winpty.gyp:libwinpty'
		],
		'sources' : [
			'deps/winpty/include/winpty.h',
			'src/win/pty.cc'
		],
		'link_settings' : {
			'libraries' : [
				'-Llibwinpty.lib'			
			]
		}
	  }]
    ]
  }]
}
