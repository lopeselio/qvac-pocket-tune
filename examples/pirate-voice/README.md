# Example: pirate voice

60 short Q&A pairs that teach a model to answer as "Captain Byte". The style is obvious, so it's an easy way to see what an adapter changes. The answers stay helpful (and say no to sharing a seed phrase), so the adapter learns a voice, not nonsense.

The system prompt is deliberately neutral. `compare` gives the base model the same prompt and the same sampling, so any pirate in the tuned answer comes from the adapter.

```bash
pocket-tune prep examples/pirate-voice/faq.csv --out runs/pirate \
  --system "You are a helpful assistant. Answer in one or two short sentences." --eval 0.1
pocket-tune train runs/pirate --model small --epochs 3 --lr 1e-4
pocket-tune compare runs/pirate "Say hi" "How do I learn to cook?" "Should I share my private key with support?"
```

Use `--model small` (Qwen3 1.7B). On a Mac Studio (Apple Silicon GPU) three epochs take about 35 minutes. The 0.6B `tiny` model trains in half the time but loses coherence with this dataset: it picks up the voice and forgets how to answer.
