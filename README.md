# Pocket Tune

**Teach a small language model *your* voice, on your own device.** Point Pocket Tune at your notes, a WhatsApp export or an FAQ. It turns them into a training set, scrubs secrets and identifiers, then trains a LoRA adapter locally with [Tether QVAC](https://docs.qvac.tether.io/sdk/ai-capabilities/fine-tuning)'s on-device fine-tuning. Your data never leaves the machine.

The result is a ~20 MB adapter you can chat with, compare against the base model, and (if you want) share peer-to-peer as a `pear://` link through [qvac-seed](https://github.com/lopeselio/qvac-seed).

```console
$ pocket-tune prep examples/pirate-voice/faq.csv --out runs/pirate \
    --system "You are a helpful assistant. Answer in one or two short sentences."
✔ SFT dataset written to runs/pirate
  49 train / 10 eval conversations (dropped: 0 duplicate, 0 too long, 0 empty)

$ pocket-tune train runs/pirate --model small --epochs 3 --lr 1e-4
▸ memory check: QWEN3_1_7B_INST_Q4: likely fits (gpu)
✔ adapter: runs/pirate/trained-lora-adapter.gguf (34.9 MB)

$ pocket-tune compare runs/pirate "How do I learn to cook?" "Should I share my private key with support?"
❯ How do I learn to cook?
  base : Start with simple recipes, use basic ingredients, and practice regularly. Explore different cuisines to expand your skills, and don’t hesitate to experiment with flavors!
  tuned: Start with the basics, matey! Ye can’t sail a ship without first learning how to read the sea. Arr!
❯ Should I share my private key with support?
  base : Sharing your private key with support is not safe, as it compromises your account security. Always keep your private key secure and avoid sharing it with third parties. […]
  tuned: No, matey! The ship of the private key is not for sale. Arr! Matey!
```

*(Real output from a Mac Studio (Apple Silicon GPU) with Qwen3-1.7B; neither prompt is in the training set. Both models get the same neutral system prompt and the same sampling, so the voice comes from the adapter. With 60 examples you get a style shift, not a personality clone. Bring a few hundred real conversations for that.)*

## Why

QVAC can fine-tune LoRA adapters on laptops and phones (including BitNet models on mobile GPUs), but `finetune()` expects a clean JSONL file and a compatible base model. Getting from "my notes" to a working adapter is the hard part:

- **Sources people actually have.** Markdown/Obsidian notes, WhatsApp exports (Android and iOS formats, multi-line messages, media lines), chat JSON/JSONL, and Q&A CSVs.
- **Your messages become the assistant turns.** Pass `--me "Your Name"` and your replies become the training targets. Silences longer than an hour start a new conversation.
- **Scrubbing before training.** Emails, phone numbers, wallet addresses, private keys, API tokens, IBANs, card numbers and BIP-39 seed phrases are replaced by placeholders. LoRA weights can memorise text, and adapters get shared.
- **Dataset hygiene.** Near-duplicate removal, context-length filtering, and a deterministic train/eval split, so re-running gives the same split.
- **Compatibility checks.** QVAC only fine-tunes `qwen3`, `gemma3` and `bitnet` models in F32/F16/Q4_0/Q8_0/TQ1_0/TQ2_0. Pocket Tune checks this before you download gigabytes (many catalog models are Q4_K_M and would fail).
- **A memory check before downloading.** QVAC's `assessModelFit()` measures the base model against this device's free memory using the registry's tensor list (tens of KB), never the weights. Pocket Tune refuses a model that likely won't fit (`--force` overrides). Training needs extra headroom on top of the model, so "likely fits" is necessary but not sufficient.
- **Pause and resume.** Ctrl+C pauses at the next step and saves a checkpoint, and `pocket-tune resume` continues from it. That suits phones and laptops on battery. (QVAC can only resume a *paused* run; a run that crashed or was killed has to start again.)
- **Sampling that suits a small tuned model.** `chat` and `compare` use a low temperature, a repeat penalty and a fixed seed. With chat-style defaults a fresh adapter tends to loop ("Matey! Matey! Matey!…"), and a fixed seed makes `compare` reproducible.
- **An adapter card.** `adapter.json` records the base model (name and sha256), hyperparameters, metrics and dataset hashes. It never contains the data itself.

## Install

```bash
npm install -g qvac-pocket-tune          # puts `pocket-tune` on your PATH
npm install qvac-pocket-tune   # library (Node), or `qvac-pocket-tune/core` anywhere
```

From source: `git clone https://github.com/lopeselio/qvac-pocket-tune && cd qvac-pocket-tune && npm install`.

Node.js 22+. The base model downloads on first use (Qwen3-0.6B is 382 MB).

## Usage

```
pocket-tune prep <files/dirs...> --out <run> [--me "Your Name"] [--system "..."]
                 [--type notes|whatsapp|chat-json|qa-csv] [--eval 0.1] [--no-scrub]
pocket-tune train <run> [--model tiny] [--epochs 2] [--lr 1e-4] [--ctx 512] [--cpu] [--force]
pocket-tune resume <run>
pocket-tune chat <run> [--base]
pocket-tune compare <run> "prompt one" ["prompt two"...]
pocket-tune share <run> --name <adapter-name> [--no-seed]
pocket-tune models
```

| Data | Becomes | Notes |
|---|---|---|
| `notes/` (`.md`, `.txt`) | causal (plain text) | Front matter, code blocks, images and link syntax are stripped |
| `WhatsApp Chat with Sam.txt` | SFT conversations | Needs `--me "Your Name"` exactly as it appears in the export |
| `*.json`, `*.jsonl` | SFT conversations | `{messages:[{role,content}]}` per line, or a JSON array |
| `*.csv` | SFT Q&A pairs | Columns named question/answer, prompt/response or input/output |

Notes and chats can't be mixed in one run, because QVAC trains either SFT or causal. Prep them into separate runs.

### Base models

| Preset | Model | Mode | |
|---|---|---|---|
| `tiny` (default) | Qwen3 0.6B Q4_0, 382 MB | SFT | phone-friendly |
| `small` | Qwen3 1.7B Q4_0, 1.1 GB | SFT | phone-friendly |
| `bitnet` | BitNet b1.58 0.7B TQ2_0, 217 MB | causal | phone-friendly |
| `bitnet-1b` | BitNet b1.58 1B TQ2_0, 835 MB | causal | phone-friendly |
| `bitnet-3b` | BitNet b1.58 3B TQ2_0, 1.9 GB | causal | desktop |

You can also pass any QVAC model constant or a local `.gguf` that meets the requirements above.

### Sharing

```bash
pocket-tune share runs/pirate --name pirate-voice
# adapter: pear://9c1e…/pirate-voice/adapter.gguf
# card:    pear://9c1e…/pirate-voice/adapter.json
```

Only the adapter and its card are published. Anyone can then fetch it, verified, with `npx qvac-seed fetch <url>` and load it on the same base model via `modelConfig.lora`.

## Mobile app

[`mobile/`](mobile/) is an Expo app with the same flow on a phone: pick files, build a scrubbed dataset, fine-tune on the phone's GPU (with memory check, pause and resume), then compare the base and adapted answers. It bundles the same core module as the CLI. QVAC needs a physical device; see [mobile/README.md](mobile/README.md).

## Library

The parsing, scrubbing, dataset and fine-tune-option code has no Node built-ins and is exported separately as `qvac-pocket-tune/core`, which the mobile app bundles.

```js
import * as sdk from '@qvac/sdk'
import { prep, train, compare } from 'qvac-pocket-tune'

await prep(['./notes'], { outDir: 'runs/notes' })
const res = await train({ sdk, runDir: 'runs/notes', model: 'bitnet', hyper: { numberOfEpochs: 3 } })
console.log(res.adapter, res.card.metrics)
```

## Caveats

- Scrubbing is a best-effort, regex- and wordlist-based filter, not a guarantee. Review `train.jsonl` before training on sensitive material, and before sharing an adapter.
- An adapter only works with the exact base model it was trained on. The card records that model's sha256.

## Development

```bash
npm test   # parsers, scrubber, dataset builder, trainer (fake SDK), chat/compare, share via qvac-seed
```

## License

Apache-2.0
