/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');

const TEST_FILE_PATTERN = /\.(?:spec|test)\.(?:js|jsx|ts|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'node_modules']);

function discoverNodeNativeTests(rootDir) {
  const matches = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !TEST_FILE_PATTERN.test(entry.name)) continue;

      const testPath = path.join(directory, entry.name);
      const source = fs.readFileSync(testPath, 'utf8');
      if (source.includes('node:test')) matches.push(testPath);
    }
  }

  return matches.sort();
}

function toCrossPlatformPattern(relativePath) {
  return relativePath
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
}

module.exports = { discoverNodeNativeTests, toCrossPlatformPattern };
