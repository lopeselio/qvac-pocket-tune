# Pocket Tune mobile

The Pocket Tune flow on your phone: **pick your files → build a scrubbed dataset → fine-tune a LoRA adapter on the phone's GPU → compare it with the base model.** Built with Expo (SDK 54) and the [QVAC SDK](https://docs.qvac.tether.io/resources/tutorials/expo). Nothing leaves the device except the one-time base-model download.

| Data | Train | Try |
|---|---|---|
| Pick a WhatsApp export, Q&A CSV, chat JSONL or notes (or use the bundled pirate sample). Personal data is scrubbed before anything is written. | Choose a phone-friendly base model (Qwen3 0.6B/1.7B, BitNet 0.7B/1B), check memory *before* downloading, and watch loss and accuracy live. Pause any time and resume later from the checkpoint. | Ask one prompt and see the base model's answer next to your adapter's. |

The parsing, scrubbing, dataset and fine-tune-option code is the **same module the CLI uses** (`../src/core.js`). Metro bundles it straight from the parent folder, so the app and the CLI can't drift apart.

## Requirements

- **A physical iOS or Android device.** QVAC's llama.cpp backend doesn't run on simulators or emulators.
- Node `^22.21.0` or `>=24.9.0`, which QVAC's mobile bundler requires (see `.nvmrc`).
- Xcode (iOS) or Android Studio with an NDK (Android). Android needs API 29+ and an arm64 device.

## Run

```bash
cd mobile
nvm use            # Node 24
npm install
npx expo prebuild  # generates ios/ and android/, and links QVAC's native addons
npx expo run:android --device   # or: npx expo run:ios --device
```

Run `npx expo prebuild` again after any `npm install`, because reinstalling clears the linked addons. `ios/` and `android/` are generated (Continuous Native Generation), so configure native behaviour in `app.json` instead of editing them.

### Xcode 27 and the UIScene life cycle

Apps built with the iOS 27 SDK must use UIKit's scene life cycle, or they stop at launch with "UIScene life cycle is required for apps built with this SDK" (in Xcode: `EXC_BREAKPOINT` on Thread 1, frozen on the splash). Expo SDK 54's template creates its window in the app delegate, so `plugins/with-ios-scene-lifecycle.js` adds a `SceneDelegate` at prebuild and moves the window there. Expo SDK 58 does this itself; remove the plugin when upgrading.

### Installing on an iPhone with a free Apple ID

Open `ios/PocketTune.xcworkspace`, pick your Personal Team under Signing & Capabilities, choose your iPhone and the **Release** configuration (Debug expects `npx expo start` running), then ⌘R. Trust the developer profile on the phone under Settings → General → VPN & Device Management. Free provisioning expires after 7 days; build again to renew. `prebuild --clean` resets the team, so set it again after one.

## Checks

```bash
npm run typecheck && npm run lint && npm test
npx expo export --platform android --platform ios   # bundles the JS, including ../src
```

CI runs all of these. After prebuild, `cd android && ./gradlew assembleRelease` produces an arm64 APK (about 218 MB, most of it QVAC's Vulkan and CPU backends plus the Bare runtime). On iOS, `xcodebuild -workspace ios/PocketTune.xcworkspace -scheme PocketTune -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build` produces a 111 MB app with BareKit, QVAC Fabric and the llama.cpp addon embedded. Sign it with your team to install it on a device.

> **Pinned:** `react-native-bare-kit` is pinned to `0.16.0`. Version 0.17 no longer packages the addons QVAC's prebuild links, so the app builds fine but ships without the QVAC runtime. The SDK's peer range (`>=0.16.0`) doesn't prevent that.

## How it maps onto QVAC

| Step | SDK call |
|---|---|
| Memory check before download | `assessModelFit({ models: [{ modelSrc, modelType: 'llamacpp-completion', modelConfig: { ctx_size } }] })` |
| Train / resume | `loadModel()` → `finetune({ modelId, options })`, then `finetune({ …, operation: 'resume' })` |
| Pause | `finetune({ modelId, operation: 'pause' })` |
| Use the adapter | `loadModel({ modelSrc, modelConfig: { lora: '<posix path>/trained-lora-adapter.gguf' } })` → `completion()` |

Runs are stored in `Documents/runs/<name>/` with the same layout as the CLI (`train.jsonl`, `eval.jsonl`, `run.json`, `checkpoints/`, `trained-lora-adapter.gguf`). QVAC's worker gets plain POSIX paths, which is the Expo `file://` URI with the scheme removed.
