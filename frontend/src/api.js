const base = '';   // proxied by Vite / served by chatbot

export async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const Conversations = {
  list:   () => api('/api/conversations'),
  get:    (id) => api(`/api/conversations/${id}`),
  create: (title) => api('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  cancel: (id) => api(`/api/conversations/${id}/cancel`, { method: 'POST' })
};
export const Providers = {
  list: () => api('/api/providers')
};
export const Metrics = {
  get: (since='1 hour') => api(`/api/metrics?since=${encodeURIComponent(since)}`)
};
