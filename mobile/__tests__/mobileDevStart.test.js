'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('mobile development launcher', () => {
  it('wakes the selected emulator before installing and launching the app', () => {
    const launcher = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'mobile_dev_start.ps1'),
      'utf8',
    );
    const wakeCall = launcher.indexOf('Wake-EmulatorScreen -Device $Device');
    const buildApk = launcher.indexOf('& $GradleWrapperPath');
    const installApk = launcher.indexOf('install -r $DebugApkPath');
    const launchApp = launcher.indexOf('shell monkey');

    expect(launcher).toContain('shell input keyevent KEYCODE_WAKEUP');
    expect(launcher).toContain('shell wm dismiss-keyguard');
    expect(wakeCall).toBeGreaterThan(-1);
    expect(buildApk).toBeGreaterThan(wakeCall);
    expect(installApk).toBeGreaterThan(buildApk);
    expect(launchApp).toBeGreaterThan(installApk);
  });
});
