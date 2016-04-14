require('child_process').execSync(
    'node-gyp rebuild',
    {'cwd': require('path').join(__dirname, '..')},
    function(err, stdout, stderr){
      if (err) {
        console.error(err);
        return;
      }
      console.log(stdout);
});
process.exit(0);
