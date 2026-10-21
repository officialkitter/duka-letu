const { withAppBuildGradle } = require('@expo/config-plugins');

// The CMake 3.22.1 that AGP picks by default bundles Ninja 1.10.2, which is not
// long-path aware, so native codegen fails in deep Windows folders even with
// LongPathsEnabled=1. CMake 4.1.2 ships Ninja 1.12+, which is. Windows-only no-op elsewhere.
const CMAKE_VERSION = '4.1.2';
const MARKER = '// duka-letu: long-path aware cmake';

module.exports = function withWindowsCmake(config) {
  if (process.platform !== 'win32') return config;
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy' || cfg.modResults.contents.includes(MARKER)) return cfg;
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /\nandroid\s*\{/,
      (m) => `${m}\n    ${MARKER}\n    externalNativeBuild {\n        cmake {\n            version "${CMAKE_VERSION}"\n        }\n    }`,
    );
    return cfg;
  });
};
