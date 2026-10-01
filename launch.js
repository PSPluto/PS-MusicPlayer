const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const cp = spawn(electronPath, ['.'], {
  env,
  stdio: 'inherit'
});

cp.on('exit', (code) => {
  process.exit(code);
});
