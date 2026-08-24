'use strict';

const fs = require('node:fs');
const path = require('node:path');

const androidApp = path.join(__dirname, '..', 'android', 'app');

describe('Android release security configuration', () => {
  it('disables backup and cleartext traffic in the base manifest', () => {
    const manifest = fs.readFileSync(
      path.join(androidApp, 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );

    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain(
      'android:dataExtractionRules="@xml/data_extraction_rules"',
    );
    expect(manifest).toContain(
      'android:fullBackupContent="@xml/backup_rules"',
    );
    expect(manifest).toContain(
      'android:usesCleartextTraffic="${usesCleartextTraffic}"',
    );
  });

  it('excludes every app-storage domain from backup and device transfer', () => {
    const extraction = fs.readFileSync(
      path.join(androidApp, 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'),
      'utf8',
    );
    const legacy = fs.readFileSync(
      path.join(androidApp, 'src', 'main', 'res', 'xml', 'backup_rules.xml'),
      'utf8',
    );
    const domains = [
      'root',
      'file',
      'database',
      'sharedpref',
      'external',
      'device_root',
      'device_file',
      'device_database',
      'device_sharedpref',
    ];

    for (const domain of domains) {
      const pattern = new RegExp(`<exclude domain="${domain}" path="\\." \\/>`, 'g');
      expect(extraction.match(pattern)).toHaveLength(2);
      expect(legacy.match(pattern)).toHaveLength(1);
    }
  });

  it('keeps benchmark non-debuggable and production signing fail-closed', () => {
    const build = fs.readFileSync(path.join(androidApp, 'build.gradle'), 'utf8');

    expect(build).toMatch(/benchmark\s*\{[\s\S]*?debuggable false/);
    expect(build).toContain(
      'Production Release signing variables are incomplete; debug signing is never used as a fallback.',
    );
    expect(build).toMatch(/preReleaseBuild[\s\S]*dependsOn\(validateProductionReleaseConfiguration\)/);
  });
});
