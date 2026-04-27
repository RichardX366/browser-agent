# Browser Agent

An extension that allows you to control your browser using an AI agent.

## Providers

The side panel supports OpenAI, Anthropic, Google Gemini, Mistral, and Kimi.
Provider API keys are saved locally per provider in `localStorage`.

## Zipping

To zip the extension, run the following command in the terminal:

```bash
cd ..
tar -a -c -f browser-agent.zip --exclude=browser-agent/.git --exclude=browser-agent/.gitignore browser-agent
```
