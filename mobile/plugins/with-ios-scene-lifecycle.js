// Apps built with the iOS 27 SDK (Xcode 27) must adopt the UIScene life
// cycle, or UIKit refuses to launch them ("UIScene life cycle is required for
// apps built with this SDK"). Expo SDK 54's template creates the window in the
// app delegate, so this plugin moves that into a scene delegate at prebuild:
//
//   1. Info.plist gets a UIApplicationSceneManifest pointing at SceneDelegate.
//   2. AppDelegate.swift stops creating a window (it still builds the React
//      Native factory, which the scene delegate uses).
//   3. SceneDelegate.swift is added to the app target. It creates the window
//      for the scene and starts React Native in it, and forwards deep links.
//
// Expo SDK 58 does this itself; drop this plugin when upgrading to it.

const fs = require('fs')
const path = require('path')
// Loaded on use, so tests can import the constants below without mobile/'s
// node_modules (the root test run picks up mobile/test too).
const plugins = () => require('@expo/config-plugins')

const FILE = 'SceneDelegate.swift'

const SCENE_DELEGATE = `import Expo
import React
import UIKit

// Added by plugins/with-ios-scene-lifecycle.js. Do not edit: ios/ is generated.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    // A link that cold-launched the app arrives here, not in launchOptions.
    // Rebuild the launch options React Native's Linking.getInitialURL reads.
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    } else if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    // Sets the root view controller and makes the window key and visible.
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
  }

  // Links opened while the app is running.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      _ = RCTLinkingManager.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  // Universal links.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
`

// The window block in Expo SDK 54's AppDelegate.swift template.
const WINDOW_BLOCK = /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\([\s\S]*?\)\s*#endif\n?/

function withSceneManifest (config) {
  const { withInfoPlist } = plugins()
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate'
        }]
      }
    }
    return cfg
  })
}

function withoutAppDelegateWindow (config) {
  const { withAppDelegate } = plugins()
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') throw new Error('with-ios-scene-lifecycle: expected a Swift AppDelegate')
    const src = cfg.modResults.contents
    if (src.includes('SceneDelegate creates the window')) return cfg
    if (!WINDOW_BLOCK.test(src)) {
      throw new Error('with-ios-scene-lifecycle: AppDelegate.swift no longer matches the Expo SDK 54 template; update the plugin (or drop it on SDK 58+).')
    }
    cfg.modResults.contents = src.replace(WINDOW_BLOCK, '// The SceneDelegate creates the window and starts React Native (UIScene life cycle).\n')
    return cfg
  })
}

function withSceneDelegateFile (config) {
  const { withDangerousMod, withXcodeProject, IOSConfig } = plugins()
  config = withDangerousMod(config, ['ios', async (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName)
    fs.writeFileSync(path.join(dir, FILE), SCENE_DELEGATE)
    return cfg
  }])
  return withXcodeProject(config, (cfg) => {
    const group = cfg.modRequest.projectName
    const filepath = `${group}/${FILE}`
    if (!cfg.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: group, project: cfg.modResults })
    }
    return cfg
  })
}

module.exports = function withIosSceneLifecycle (config) {
  return withSceneDelegateFile(withoutAppDelegateWindow(withSceneManifest(config)))
}

module.exports._test = { SCENE_DELEGATE, WINDOW_BLOCK }
