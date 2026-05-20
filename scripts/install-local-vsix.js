const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const latestVsix = fs
  .readdirSync(root)
  .filter((fileName) => fileName.endsWith('.vsix'))
  .map((fileName) => {
    const filePath = path.join(root, fileName);
    return { fileName, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
  })
  .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

if (!latestVsix) {
  console.error('No .vsix file found. Run `npm run release:local` first.');
  process.exit(1);
}

const result = spawnSync('code', ['--install-extension', latestVsix.filePath], {
  stdio: 'inherit'
});

if (result.error) {
  console.error(`Failed to run VS Code CLI: ${result.error.message}`);
  console.error(`Install manually with: code --install-extension ${latestVsix.fileName}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
