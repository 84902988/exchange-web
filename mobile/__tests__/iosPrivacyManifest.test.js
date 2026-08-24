'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('iOS privacy manifest packaging', () => {
  const manifestPath = path.join(
    __dirname,
    '..',
    'ios',
    'ExchangeMobile',
    'PrivacyInfo.xcprivacy',
  );
  const projectPath = path.join(
    __dirname,
    '..',
    'ios',
    'ExchangeMobile.xcodeproj',
    'project.pbxproj',
  );

  it('declares current linked app data without tracking', () => {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    for (const dataType of [
      'NSPrivacyCollectedDataTypeEmailAddress',
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypeOtherFinancialInfo',
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypeOtherUserContent',
    ]) {
      expect(manifest).toContain(`<string>${dataType}</string>`);
    }
    expect(manifest).toContain('<key>NSPrivacyTracking</key>\n\t<false/>');
  });

  it('packages PrivacyInfo.xcprivacy in the application resources phase', () => {
    const project = fs.readFileSync(projectPath, 'utf8');
    expect(project).toContain('PrivacyInfo.xcprivacy in Resources');
    expect(project).toMatch(
      /PBXResourcesBuildPhase[\s\S]*files = \([\s\S]*PrivacyInfo\.xcprivacy in Resources[\s\S]*\);/,
    );
  });
});
