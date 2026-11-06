# Example: scrubbing a chat export

`WhatsApp Chat with Sam.txt` is a made-up chat full of the things people actually paste into chats: an email, a phone number, a USDT address, a seed phrase, an IBAN, a card number and an API key. All of them are public test values.

```bash
pocket-tune prep "examples/scrub-demo/WhatsApp Chat with Sam.txt" --me Alex --out runs/scrub-demo
#   redacted: 1 EMAIL, 1 PHONE, 1 EVM_ADDRESS, 1 SEED_PHRASE, 1 IBAN, 1 CARD, 1 API_KEY — review the files before training
```

Alex's messages become the assistant turns in `runs/scrub-demo/train.jsonl`, with every secret replaced:

```
assistant: write them on paper, never in a chat. mine were [SEED_PHRASE] lol jk that's the test one
assistant: you pasted your key in the code: [API_KEY]. rotate it, then read the stack trace from the bottom up
```
