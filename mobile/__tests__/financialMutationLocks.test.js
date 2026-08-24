const fs = require('fs');
const path = require('path');

const readSource = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('financial mutation synchronous locks', () => {
  test.each([
    ['src/screens/assets/TransferScreen.tsx', 'submitLockRef'],
    ['src/screens/assets/UserTransferScreen.tsx', 'submitLockRef'],
    ['src/screens/assets/WithdrawScreen.tsx', 'draftSubmitLockRef'],
    ['src/screens/assets/WithdrawScreen.tsx', 'codeSendLockRef'],
    ['src/screens/assets/WithdrawScreen.tsx', 'confirmLockRef'],
    ['src/screens/assets/AssetsScreen.tsx', 'bdSubmitLockRef'],
  ])('%s guards mutations with %s', (relativePath, lockName) => {
    const source = readSource(relativePath);

    expect(source).toMatch(new RegExp(`if\\s*\\(\\s*${lockName}\\.current`));
    expect(source).toContain(`${lockName}.current = true`);
    expect(source).toContain(`${lockName}.current = false`);
  });
});
