import Anthropic from '@anthropic-ai/sdk';

/**
 * Adapter contract:
 *   complete({ model, messages, system, signal })            -> { text, usage }
 *   stream({ model, messages, system, signal, onDelta })     -> { text, usage, ttftMs }
 *
 * Each provider adapter normalises into:
 *   usage = { prompt_tokens, completion_tokens, total_tokens }
 */

export class AnthropicProvider {
  constructor({ apiKey }) {
    if (!apiKey) throw new Error('AnthropicProvider: apiKey required');
    this.client = new Anthropic({ apiKey });
    this.name = 'anthropic';
  }

  _split(messages) {
    // Anthropic wants `system` as a top-level arg, not in messages.
    const sys = messages.find(m => m.role === 'system')?.content;
    const rest = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));
    return { system: sys, messages: rest };
  }

  async complete({ model, messages, signal, maxTokens = 1024 }) {
    const { system, messages: msgs } = this._split(messages);
    const res = await this.client.messages.create({
      model,
      system,
      messages: msgs,
      max_tokens: maxTokens
    }, { signal });
    const text = res.content?.map(p => p.text || '').join('') ?? '';
    return {
      text,
      usage: {
        prompt_tokens: res.usage?.input_tokens ?? null,
        completion_tokens: res.usage?.output_tokens ?? null,
        total_tokens:
          (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0) || null
      }
    };
  }

  async stream({ model, messages, signal, onDelta, maxTokens = 1024 }) {
    const { system, messages: msgs } = this._split(messages);
    const start = Date.now();
    let ttftMs = null;
    let fullText = '';
    let usage = { prompt_tokens: null, completion_tokens: null, total_tokens: null };

    const stream = await this.client.messages.stream({
      model,
      system,
      messages: msgs,
      max_tokens: maxTokens
    }, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        if (ttftMs == null) ttftMs = Date.now() - start;
        fullText += event.delta.text;
        onDelta?.(event.delta.text);
      } else if (event.type === 'message_delta' && event.usage) {
        usage.completion_tokens = event.usage.output_tokens ?? usage.completion_tokens;
      } else if (event.type === 'message_start' && event.message?.usage) {
        usage.prompt_tokens = event.message.usage.input_tokens ?? null;
      }
    }
    if (usage.prompt_tokens != null || usage.completion_tokens != null) {
      usage.total_tokens =
        (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    }
    return { text: fullText, usage, ttftMs };
  }
}
