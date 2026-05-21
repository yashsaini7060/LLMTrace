/**
 * Minimal SSE-over-POST helper.
 *
 * We can't use EventSource for chat because it's GET-only and we need to
 * POST a message body. Instead we use fetch with a streamed response body
 * and parse the SSE wire format ourselves.
 *
 * Usage:
 *   const ctrl = new AbortController();
 *   await streamSSE('/api/.../chat', { body, signal: ctrl.signal,
 *     on: { token: d => ..., done: d => ..., error: d => ..., cancelled: d => ... }
 *   });
 */
export async function streamSSE(url, { body, signal, on = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`stream failed ${res.status}: ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by blank lines
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseEvent(raw);
      if (evt && on[evt.event]) on[evt.event](evt.data);
    }
  }
}

function parseEvent(raw) {
  const lines = raw.split('\n');
  let event = 'message', data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  try { return { event, data: JSON.parse(data) }; }
  catch { return { event, data }; }
}
