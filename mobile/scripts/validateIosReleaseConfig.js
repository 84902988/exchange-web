'use strict';

const {isIP} = require('node:net');

function requireValue(config, key) {
  const value = String(config[key] || '').trim();
  if (!value) {
    throw new Error(`${key} is required for the iOS Release build`);
  }
  return value;
}

function validatePublicHttpsUrl(value, name, {originOnly}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isLocal =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');
  if (
    url.protocol !== 'https:' ||
    !hostname ||
    isIP(hostname) !== 0 ||
    isLocal ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be a credential-free public HTTPS DNS endpoint`,
    );
  }
  if (originOnly && url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must be an HTTPS origin without a path`);
  }
}

function validateIosReleaseConfig(config) {
  const apiUrl = requireValue(config, 'MOBILE_API_BASE_URL');
  const chartUrl = requireValue(config, 'MOBILE_CHART_WEB_BASE_URL');
  const bundleIdentifier = requireValue(config, 'PRODUCT_BUNDLE_IDENTIFIER');

  validatePublicHttpsUrl(apiUrl, 'MOBILE_API_BASE_URL', {originOnly: false});
  validatePublicHttpsUrl(chartUrl, 'MOBILE_CHART_WEB_BASE_URL', {
    originOnly: true,
  });
  if (
    !/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+){2,}$/.test(
      bundleIdentifier,
    ) ||
    bundleIdentifier.startsWith('org.reactjs.native.example')
  ) {
    throw new Error(
      'PRODUCT_BUNDLE_IDENTIFIER must be an explicit reverse-DNS identifier',
    );
  }
}

if (require.main === module) {
  try {
    validateIosReleaseConfig(process.env);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {validateIosReleaseConfig};
