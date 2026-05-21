# @llm-logger/sdk

Lightweight Node SDK wrapping Anthropic / OpenAI / Gemini chat APIs.
Adds:

- Uniform `chat({ model: "provider:model", messages, onDelta })` interface
- Streaming via callback (works for SSE proxy)
- Cancellation via `AbortSignal`
- PII redaction on previews + logs
- Async batched log delivery to an ingestion endpoint (never blocks the request)

```js
import { LLMClient } from '@llm-logger/sdk';

const llm = new LLMClient({
  providers: {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai:    process.env.OPENAI_API_KEY,
    gemini:    process.env.GEMINI_API_KEY
  },
  ingestion: { endpoint: 'http://localhost:4000/v1/logs', token: 'dev' }
});

const { text } = await llm.chat({
  model: 'anthropic:claude-3-5-sonnet-latest',
  messages: [{ role: 'user', content: 'hi' }],
  onDelta: t => process.stdout.write(t)
});
```
