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
    const runAndroid = launcher.indexOf('npm.cmd run android');

    expect(launcher).toContain('shell input keyevent KEYCODE_WAKEUP');
    expect(launcher).toContain('shell wm dismiss-keyguard');
    expect(wakeCall).toBeGreaterThan(-1);
    expect(runAndroid).toBeGreaterThan(wakeCall);
  });
});
