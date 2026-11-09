import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { _test: { WINDOW_BLOCK, SCENE_DELEGATE } } = require('../plugins/with-ios-scene-lifecycle.js')

// didFinishLaunching from Expo SDK 54's AppDelegate.swift template.
const TEMPLATE = `    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
`

test('the plugin removes only the app-delegate window from the SDK 54 template', () => {
  assert.match(TEMPLATE, WINDOW_BLOCK)
  const out = TEMPLATE.replace(WINDOW_BLOCK, '')
  assert.doesNotMatch(out, /UIWindow|startReactNative/)
  // The factory must still be built: the scene delegate reads it.
  assert.match(out, /reactNativeFactory = factory/)
  assert.match(out, /return super\.application/)
})

test('the scene delegate starts the same React Native module in a scene window', () => {
  assert.match(SCENE_DELEGATE, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/)
  assert.match(SCENE_DELEGATE, /UIWindow\(windowScene: windowScene\)/)
  assert.match(SCENE_DELEGATE, /startReactNative\(withModuleName: "main"/)
})
