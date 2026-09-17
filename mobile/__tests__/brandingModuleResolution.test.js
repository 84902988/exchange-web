const {execFileSync} = require('child_process');
const path = require('path');

const resolutions = JSON.parse(execFileSync(process.execPath, ['-e', `
  const fs = require('fs');
  const path = require('path');
  const {resolve} = require('metro-resolver');
  const {resolver} = require('./metro.config');
  const origin = path.resolve('src/i18n/catalog.ts');
  const imported = fs.readFileSync(origin, 'utf8').match(new RegExp("from '([^']+config/branding[^']*)'"))[1];
  const context = {
    ...resolver,
    originModulePath: origin,
    assetExts: new Set(resolver.assetExts),
    preferNativePlatform: true,
    redirectModulePath: value => value,
    getPackageForModule: () => null,
    fileSystemLookup: value => !fs.existsSync(value) ? {exists: false} : {
      exists: true,
      type: fs.statSync(value).isDirectory() ? 'd' : 'f',
      realPath: fs.realpathSync(value),
    },
  };
  console.log(JSON.stringify(['android', 'ios'].map(platform => {
    const typed = resolve(context, imported, platform);
    const json = resolve({...context, originModulePath: typed.filePath}, './branding.json', platform);
    return {platform, typed, json};
  })));
`], {cwd: path.resolve(__dirname, '..'), encoding: 'utf8'}));

describe('production branding module resolution', () => {
  test.each(['android', 'ios'])('%s loads the typed module and its JSON separately', platform => {
    const result = resolutions.find(item => item.platform === platform);
    const modulePath = path.resolve(__dirname, '../src/config/brandingConfig.ts');
    expect(result.typed).toEqual({
      type: 'sourceFile',
      filePath: modulePath,
    });
    expect(result.json).toEqual({
      type: 'sourceFile',
      filePath: path.resolve(__dirname, '../src/config/branding.json'),
    });
  });
});
