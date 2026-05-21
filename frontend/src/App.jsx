import React, { useEffect, useRef, useState } from 'react';
import { Conversations, Providers } from './api.js';
import { streamSSE } from './sse.js';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [tab, setTab] = useState('chat');     // chat | dashboard
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [convStatus, setConvStatus] = useState('active');
  const [providers, setProviders] = useState({});
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const chatRef = useRef(null);

  // Load providers + conversations on mount.
  useEffect(() => {
    Providers.list().then(p => {
      setProviders(p.providers || {});
      setModel(p.default);
    }).catch(e => setError(`providers: ${e.message}`));
    refreshConvs();
  }, []);

  // Auto-scroll chat to bottom.
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, streaming]);

  async function refreshConvs() {
    try {
      const { conversations: cs } = await Conversations.list();
      setConversations(cs);
    } catch (e) { setError(`list: ${e.message}`); }
  }

  async function loadConversation(id) {
    setError(null);
    setActiveId(id);
    try {
      const c = await Conversations.get(id);
      setMessages(c.messages || []);
      setConvStatus(c.status);
    } catch (e) { setError(`load: ${e.message}`); }
  }

  async function newConversation() {
    try {
      const c = await Conversations.create();
      await refreshConvs();
      await loadConversation(c.id);
    } catch (e) { setError(`new: ${e.message}`); }
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);

    // Ensure a conversation exists.
    let id = activeId;
    if (!id) {
      const c = await Conversations.create();
      id = c.id;
      setActiveId(id);
    }

    // Optimistic user message.
    const optimistic = [
      ...messages,
      { id: 'tmp-u', role: 'user', content: text, created_at: new Date().toISOString() },
      { id: 'tmp-a', role: 'assistant', content: '', created_at: new Date().toISOString() }
    ];
    setMessages(optimistic);
    setInput('');
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamSSE(`/api/conversations/${id}/chat`, {
        body: { message: text, model },
        signal: ctrl.signal,
        on: {
          token: ({ t }) => {
            setMessages(curr => {
              const next = curr.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: (last.content || '') + t };
              }
              return next;
            });
          },
          done: () => {
            setStreaming(false);
            refreshConvs();
          },
          cancelled: ({ partial }) => {
            setMessages(curr => {
              const next = curr.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: (partial || last.content || '') + ' [cancelled]' };
              }
              return next;
            });
            setConvStatus('cancelled');
            setStreaming(false);
            refreshConvs();
          },
          error: ({ message }) => {
            setError(message || 'stream error');
            setStreaming(false);
          }
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
      setStreaming(false);
    }
  }

  async function cancel() {
    if (!activeId) return;
    try {
      await Conversations.cancel(activeId);
      abortRef.current?.abort();
      setConvStatus('cancelled');
    } catch (e) { setError(`cancel: ${e.message}`); }
  }

  const providerOptions = [];
  for (const [p, models] of Object.entries(providers)) {
    for (const m of models) providerOptions.push(`${p}:${m}`);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Conversations</h2>
          <button className="btn" onClick={newConversation}>+ New</button>
        </div>
        <div className="conv-list">
          {conversations.length === 0 && <div className="empty">No conversations yet.</div>}
          {conversations.map(c =>
            <div
              key={c.id}
              className={'conv-item ' + (c.id === activeId ? 'active' : '')}
              onClick={() => loadConversation(c.id)}>
              <div className="conv-title">
                <span>{c.title || c.first_user_message || 'Untitled'}</span>
                {c.status === 'cancelled' && <span className="tag cancelled">cancelled</span>}
              </div>
              <div className="conv-meta">
                {c.message_count} msgs · {new Date(c.updated_at).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="tabs">
          <div className={'tab ' + (tab === 'chat' ? 'active' : '')} onClick={() => setTab('chat')}>Chat</div>
          <div className={'tab ' + (tab === 'dashboard' ? 'active' : '')} onClick={() => setTab('dashboard')}>Dashboard</div>
          <div style={{ flex: 1 }} />
          {tab === 'chat' && (
            <select className="model-select" value={model} onChange={e => setModel(e.target.value)}>
              {providerOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </div>

        <div className="status-bar">
          <span>
            {activeId ? <>conversation: <code>{activeId.slice(0, 8)}</code></> : 'no conversation'}
            {convStatus === 'cancelled' && <> · <span className="err">cancelled</span></>}
            {streaming && <> · <span className="live"><span className="streaming-dot" /> streaming</span></>}
          </span>
          <span>{error && <span className="err">⚠ {error}</span>}</span>
        </div>

        {tab === 'dashboard' ? (
          <Dashboard />
        ) : (
          <>
            <div className="chat" ref={chatRef}>
              {messages.length === 0 && <div className="empty">Start a conversation by sending a message.</div>}
              {messages.map(m =>
                <div key={m.id} className={'msg ' + m.role}>
                  <div className="avatar">{m.role === 'user' ? 'U' : 'AI'}</div>
                  <div>
                    <div className="role">{m.role}</div>
                    <div className="bubble">
                      {m.content || (streaming && m.role === 'assistant'
                        ? <span className="typing-dots"><span /><span /><span /></span>
                        : '')}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="composer">
              <textarea
                placeholder="Type a message…"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
              />
              {streaming
                ? <button className="btn btn-danger" onClick={cancel}>Cancel</button>
                : <button className="btn" onClick={send} disabled={!input.trim()}>Send</button>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
