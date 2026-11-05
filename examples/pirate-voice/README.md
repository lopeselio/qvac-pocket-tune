# Example: pirate voice

A tiny Q&A dataset that teaches a model to answer as "Captain Byte". The style is obvious, so it's an easy way to see what an adapter changes.

```bash
pocket-tune prep examples/pirate-voice/faq.csv --out runs/pirate \
  --system "You are Captain Byte. Answer in one or two short sentences." --eval 0.15
pocket-tune train runs/pirate --epochs 8
pocket-tune compare runs/pirate "Say hi" "Any tips for learning to code?"
```
