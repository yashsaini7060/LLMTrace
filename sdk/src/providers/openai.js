import OpenAI from 'openai';

export class OpenAIProvider {
  constructor({ apiKey }) {
    if (!apiKey) throw new Error('OpenAIProvider: apiKey required');
    this.client = new OpenAI({ apiKey });
    this.name = 'openai';
  }

  async complete({ model, messages, signal, maxTokens = 1024 }) {
    const res = await this.client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens
    }, { signal });
    const text = res.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: {
        prompt_tokens: res.usage?.prompt_tokens ?? null,
        completion_tokens: res.usage?.completion_tokens ?? null,
        total_tokens: res.usage?.total_tokens ?? null
      }
    };
  }

  async stream({ model, messages, signal, onDelta, maxTokens = 1024 }) {
    const start = Date.now();
    let ttftMs = null;
    let fullText = '';
    const stream = await this.client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true }
    }, { signal });

    let usage = { prompt_tokens: null, completion_tokens: null, total_tokens: null };
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (ttftMs == null) ttftMs = Date.now() - start;
        fullText += delta;
        onDelta?.(delta);
      }
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? null,
          completion_tokens: chunk.usage.completion_tokens ?? null,
          total_tokens: chunk.usage.total_tokens ?? null
        };
      }
    }
    return { text: fullText, usage, ttftMs };
  }
}
