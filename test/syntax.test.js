const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const files = [
    'launch.js',
    'locales.js',
    'main.js',
    'renderer.js',
    'taskbar.js',
    'ui-managers.js',
    'visualizer.js'
];

for (const relativePath of files) {
    const filePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing test target: ${relativePath}`);
    }
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);