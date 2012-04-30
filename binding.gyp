{
  'targets': [{
    'target_name': 'pty',
    'sources': [
      'src/pty.cc'
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
      }]
    ]
  }]
}
