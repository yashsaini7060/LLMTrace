import React, { useEffect, useState } from 'react';
import { Metrics } from '../api.js';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid
} from 'recharts';

const RANGES = [
  { label: '1h', value: '1 hour' },
  { label: '6h', value: '6 hours' },
  { label: '24h', value: '24 hours' },
  { label: '7d', value: '7 days' }
];

export default function Dashboard() {
  const [range, setRange] = useState('1 hour');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => Metrics.get(range)
      .then(d => { if (alive) { setData(d); setErr(null); } })
      .catch(e => alive && setErr(e.message));
    load();
    const t = setInterval(load, 5000);   // poll for near-real-time feel
    return () => { alive = false; clearInterval(t); };
  }, [range]);

  if (err) return <div className="dash"><div className="empty">Failed to load metrics: {err}</div></div>;
  if (!data) return <div className="dash"><div className="empty">Loading…</div></div>;

  const o = data.overall || {};
  const series = (data.series || []).map(r => ({
    t: new Date(r.t).toLocaleTimeString(),
    n: Number(r.n) || 0,
    avg_latency: Number(r.avg_latency) || 0,
    errors: Number(r.errors) || 0
  }));
  const byModel = data.byModel || [];

  return (
    <div className="dash">
      <div className="range-bar">
        {RANGES.map(r =>
          <button
            key={r.value}
            className={'tab ' + (range === r.value ? 'active' : '')}
            onClick={() => setRange(r.value)}>
            {r.label}
          </button>
        )}
      </div>

      <div className="cards">
        <Card label="Requests"     value={o.total ?? 0} glass />
        <Card label="Success"      value={o.ok ?? 0} glass />
        <Card label="Errors"       value={o.errors ?? 0} accent={o.errors > 0 ? 'var(--error)' : null} glass />
        <Card label="Cancelled"    value={o.cancelled ?? 0} />
        <Card label="Avg latency"  value={fmtMs(o.avg_latency)} />
        <Card label="p50"          value={fmtMs(o.p50)} />
        <Card label="p95"          value={fmtMs(o.p95)} />
        <Card label="p99"          value={fmtMs(o.p99)} />
        <Card label="Tokens"       value={o.tokens ?? 0} />
      </div>

      <div className="dash-row">
        <h3>Throughput (requests / min)</h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={series}>
            <CartesianGrid stroke="#262b38" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <YAxis stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: 12 }} />
            <Bar dataKey="n" fill="#6c8cff" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="dash-row">
        <h3>Avg latency (ms)</h3>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={series}>
            <CartesianGrid stroke="#262b38" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <YAxis stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: 12 }} />
            <Line type="monotone" dataKey="avg_latency" stroke="#6cd28b" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="dash-row">
        <h3>Errors over time</h3>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={series}>
            <CartesianGrid stroke="#262b38" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <YAxis stroke="#8b93a7" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: 12 }} />
            <Bar dataKey="errors" fill="#ff6b6b" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="dash-row">
        <h3>By model</h3>
        <table className="table">
          <thead>
            <tr><th>Provider</th><th>Model</th><th>Requests</th><th>Avg latency</th><th>Errors</th><th>Tokens</th></tr>
          </thead>
          <tbody>
            {byModel.map((r, i) =>
              <tr key={i}>
                <td>{r.provider}</td><td>{r.model}</td><td>{r.n}</td>
                <td>{fmtMs(r.avg_latency)}</td>
                <td style={{ color: Number(r.errors) > 0 ? 'var(--error)' : 'inherit' }}>{r.errors}</td>
                <td>{r.tokens || 0}</td>
              </tr>
            )}
            {byModel.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No data in this range.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, accent, glass }) {
  return (
    <div className={'card' + (glass ? ' glass' : '')}>
      <div className="l">{label}</div>
      <div className="v" style={accent ? { color: accent } : null}>{value ?? '—'}</div>
    </div>
  );
}
function fmtMs(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}
