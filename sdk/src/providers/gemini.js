import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Gemini message shape differs:
 *   { role: 'user'|'model', parts: [{ text }] }
 * We translate from the chat-completions style messages array.
 */
function toGeminiHistory(messages) {
  const sys = messages.find(m => m.role === 'system')?.content;
  const convo = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
  return { systemInstruction: sys, history: convo };
}

export class GeminiProvider {
  constructor({ apiKey }) {
    if (!apiKey) throw new Error('GeminiProvider: apiKey required');
    this.client = new GoogleGenerativeAI(apiKey);
    this.name = 'gemini';
  }

  async complete({ model, messages, signal, maxTokens = 1024 }) {
    const { systemInstruction, history } = toGeminiHistory(messages);
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction,
      generationConfig: { maxOutputTokens: maxTokens }
    });
    // Last user message is "the prompt"; rest is history.
    const last = history.pop();
    const chat = m.startChat({ history });
    const res = await chat.sendMessage(last.parts[0].text, { signal });
    const text = res.response.text();
    const usage = res.response.usageMetadata || {};
    return {
      text,
      usage: {
        prompt_tokens: usage.promptTokenCount ?? null,
        completion_tokens: usage.candidatesTokenCount ?? null,
        total_tokens: usage.totalTokenCount ?? null
      }
    };
  }

  async stream({ model, messages, signal, onDelta, maxTokens = 1024 }) {
    const { systemInstruction, history } = toGeminiHistory(messages);
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction,
      generationConfig: { maxOutputTokens: maxTokens }
    });
    const last = history.pop();
    const chat = m.startChat({ history });

    const start = Date.now();
    let ttftMs = null;
    let fullText = '';
    const res = await chat.sendMessageStream(last.parts[0].text, { signal });
    for await (const chunk of res.stream) {
      const t = chunk.text?.();
      if (t) {
        if (ttftMs == null) ttftMs = Date.now() - start;
        fullText += t;
        onDelta?.(t);
      }
    }
    const final = await res.response;
    const usage = final.usageMetadata || {};
    return {
      text: fullText,
      usage: {
        prompt_tokens: usage.promptTokenCount ?? null,
        completion_tokens: usage.candidatesTokenCount ?? null,
        total_tokens: usage.totalTokenCount ?? null
      },
      ttftMs
    };
  }
}
