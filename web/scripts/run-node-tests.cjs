/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('child_process');
const path = require('path');

const { discoverNodeNativeTests } = require('./test-file-discovery.cjs');

const rootDir = path.resolve(__dirname, '..');
const testFiles = discoverNodeNativeTests(rootDir);

if (testFiles.length === 0) {
  console.error('No node:test files were discovered.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} node:test files with the TypeScript loader.`);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { cwd: rootDir, env: process.env, stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
