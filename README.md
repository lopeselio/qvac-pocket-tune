# Pocket Tune

**Teach a small language model *your* voice, on your own device.** Point Pocket Tune at your notes, a WhatsApp export or an FAQ. It turns them into a training set, scrubs secrets and identifiers, then trains a LoRA adapter locally with [Tether QVAC](https://docs.qvac.tether.io/sdk/ai-capabilities/fine-tuning)'s on-device fine-tuning. Your data never leaves the machine.

The result is a ~20 MB adapter you can chat with, compare against the base model, and (if you want) share peer-to-peer as a `pear://` link through [qvac-seed](https://github.com/lopeselio/qvac-seed).

```console
$ pocket-tune prep examples/pirate-voice/faq.csv --out runs/pirate --system "You are Captain Byte."
✔ SFT dataset written to runs/pirate
  12 train / 2 eval conversations (dropped: 0 duplicate, 0 too long, 0 empty)

$ pocket-tune train runs/pirate --epochs 8
▸ epoch 8 train batch 48/48  loss 0.409  acc 0.715  eta 0s
✔ adapter: runs/pirate/trained-lora-adapter.gguf (20.2 MB)

$ pocket-tune compare runs/pirate "Say hi" "What should I eat for dinner?"
❯ Say hi
  base : Hello! How can I assist you today?
  tuned: The first mate of Byte! And the sailor of the bytes!
❯ What should I eat for dinner?
  base : For dinner, consider a balanced meal with vegetables, proteins, and a main dish. Options include…
  tuned: Bread and eggs.
```

*(Real output from a MacBook (Apple Silicon GPU) with Qwen3-0.6B. Training 8 epochs on 14 examples took a few minutes. With 14 examples you get a style shift, not a personality clone. Bring a few hundred real conversations for that.)*

## Why

QVAC can fine-tune LoRA adapters on laptops and phones (including BitNet models on mobile GPUs), but `finetune()` expects a clean JSONL file and a compatible base model. Getting from "my notes" to a working adapter is the hard part:

- **Sources people actually have.** Markdown/Obsidian notes, WhatsApp exports (Android and iOS formats, multi-line messages, media lines), chat JSON/JSONL, and Q&A CSVs.
- **Your messages become the assistant turns.** Pass `--me "Your Name"` and your replies become the training targets. Silences longer than an hour start a new conversation.
- **Scrubbing before training.** Emails, phone numbers, wallet addresses, private keys, API tokens, IBANs, card numbers and BIP-39 seed phrases are replaced by placeholders. LoRA weights can memorise text, and adapters get shared.
- **Dataset hygiene.** Near-duplicate removal, context-length filtering, and a deterministic train/eval split, so re-running gives the same split.
- **Compatibility checks.** QVAC only fine-tunes `qwen3`, `gemma3` and `bitnet` models in F32/F16/Q4_0/Q8_0/TQ1_0/TQ2_0. Pocket Tune checks this before you download gigabytes (many catalog models are Q4_K_M and would fail).
- **Pause and resume.** Ctrl+C pauses at the next step and saves a checkpoint, and `pocket-tune resume` continues from it. That suits phones and laptops on battery.
- **An adapter card.** `adapter.json` records the base model (name and sha256), hyperparameters, metrics and dataset hashes. It never contains the data itself.

## Install

```bash
git clone https://github.com/lopeselio/qvac-pocket-tune && cd qvac-pocket-tune
npm install
npm link   # optional: puts `pocket-tune` on your PATH
```

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

## Library

The parsing, scrubbing and dataset code is pure JavaScript with no Node-only APIs in the hot path, so it can run inside an Expo app next to the QVAC SDK.

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
- Mobile: the library is built to run under Expo, but this repo ships the CLI only for now. A React Native app is on the roadmap.

## Development

```bash
npm test   # parsers, scrubber, dataset builder, trainer (fake SDK), chat/compare, share via qvac-seed
```

## License

Apache-2.0
