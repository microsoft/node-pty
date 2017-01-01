require('child_process').exec(
    'node-gyp rebuild --debug',
    {'cwd': require('path').join(__dirname, '..')},
    function(err, stdout, stderr){
      if (err) {
        console.log(err);
      }
      console.log(stdout);
      process.exit(0);
});
