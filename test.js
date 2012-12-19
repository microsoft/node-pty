var terminal = require('./index');

var term = terminal.fork('cmd.exe', [], {
    name : 'Windows Shell',
    cols : 80,
    rows : 30,
    cwd : process.env.HOME,
    env : process.env
});

term.ready(function() {    
   term.on('data', function(data) {
      console.log(data.toString('utf8'));
   });
});
