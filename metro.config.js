const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Ignore build artifacts and cache dirs to avoid ENOSPC (file watcher limit)
config.watchFolders = [];

if (!config.resolver) config.resolver = {};
if (!config.resolver.blockList) {
  config.resolver.blockList = [];
} else if (!Array.isArray(config.resolver.blockList)) {
  config.resolver.blockList = [config.resolver.blockList];
}

config.resolver.blockList.push(
  /node_modules\/\.cache\//,
  /node_modules\/.*\/\.cache\//,
  /node_modules\/.*\/cacheable\//,
  /node_modules\/.*\/caches-jvm\//,
  /node_modules\/.*\/caches-js\//,
);

module.exports = config;
