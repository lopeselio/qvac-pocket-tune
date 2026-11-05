// Bundle the shared, Node-free core from ../src (the same code the CLI uses).
// Only ../src is watched, so the parent's node_modules stays invisible and the
// core's dependencies resolve from this app's node_modules.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const sharedSrc = path.resolve(__dirname, '..', 'src')

config.watchFolders = [sharedSrc]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]

module.exports = config
