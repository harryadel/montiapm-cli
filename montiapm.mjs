#!/usr/bin/env node
// montiapm: CLI + MCP server for the Monti APM REST API (https://api.montiapm.com/v1)
// Zero dependencies. Node >= 18.
//
//   montiapm metrics [--collection system] [--json]
//   montiapm query --metric system.pcpu [--agg avg] [--type timeseries|summary|breakdown]
//                  [--from 7d|<iso>] [--to now|<iso>] [--dim tag:host]... [--filter tag:host=value|tag:host~regex]...
//                  [--app <appId>]... [--step 5m] [--json|--csv]
//   montiapm mcp        # stdio MCP server exposing list_metrics + query_metric
//
// Auth: MONTI_API_TOKEN env, else MONTI_API_TOKEN_FILE, else ~/.config/montiapm/token
// Default app: MONTI_APP_ID env (comma separated for several)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BASE = process.env.MONTI_API_BASE || 'https://api.montiapm.com/v1';

function readToken() {
  if (process.env.MONTI_API_TOKEN) return process.env.MONTI_API_TOKEN.trim();
  const file = process.env.MONTI_API_TOKEN_FILE || path.join(os.homedir(), '.config', 'montiapm', 'token');
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { throw new Error(`No Monti token. Set MONTI_API_TOKEN or write it to ${file}`); }
}

function defaultAppIds() {
  return (process.env.MONTI_APP_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { authorization: `Bearer ${readToken()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Monti ${method} ${route} -> HTTP ${res.status}: ${data.message || data.error || text}`);
  return data;
}

// ---------- time helpers ----------
const UNIT_MS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
export function parseTime(v, now = Date.now()) {
  if (v == null || v === 'now') return now;
  if (typeof v === 'number') return v;
  const rel = /^(\d+)([smhdw])$/.exec(v);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];
  if (/^\d{12,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Bad time: ${v}`);
  return t;
}
export function parseStep(v) {
  if (!v) return 0;
  const m = /^(\d+)([smhd])$/.exec(v);
  if (!m) throw new Error(`Bad step: ${v} (use e.g. 5m, 1h)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

// ---------- filters ----------
// CLI form: tag:host=value | tag:host!=value | tag:host~regex
export function parseFilter(s) {
  const m = /^([^=!~]+)(!=|=|~)(.*)$/.exec(s);
  if (!m) throw new Error(`Bad filter: ${s} (use tag:host=value, tag:host!=value or tag:host~regex)`);
  const operator = m[2] === '=' ? 'is' : m[2] === '!=' ? 'isNot' : 'matchesRegex';
  return { tagId: m[1], operator, values: [m[3]] };
}

// ---------- query ----------
export async function listMetrics({ collection } = {}) {
  const data = await api('GET', '/metrics');
  if (collection) data.collections = data.collections.filter(c => c.id === collection);
  return data;
}

export async function queryMetric(opts) {
  const appIds = (opts.appIds && opts.appIds.length ? opts.appIds : defaultAppIds());
  if (!appIds.length) throw new Error('No app id. Pass --app or set MONTI_APP_ID');
  const body = {
    appIds,
    type: opts.type || 'timeseries',
    metric: opts.metric,
  };
  if (opts.aggregation) body.aggregation = opts.aggregation;
  if (opts.from != null || opts.to != null) {
    body.endTime = parseTime(opts.to);
    body.startTime = parseTime(opts.from ?? '1h', body.endTime);
  }
  if (opts.dimensions && opts.dimensions.length) body.dimensions = opts.dimensions;
  if (opts.filters && opts.filters.length) body.filters = opts.filters;
  const raw = await api('POST', '/query', body);
  return { request: body, ...normalize(raw, body, parseStep(opts.step)) };
}

// Monti returns parallel flat arrays: timestamps[], metrics[metric][], tags[dim][] (one row per (dimension value, timestamp)).
// Normalize into one series per dimension value, with optional client-side downsampling (mean per bucket).
export function normalize(raw, body, stepMs) {
  const metric = body.metric;
  const values = raw.metrics?.[metric] || [];
  const ts = raw.timestamps || [];
  const dims = body.dimensions || [];
  if (body.type !== 'timeseries') {
    // summary: single value; breakdown: one value per dimension value
    const labels = dims.map(d => raw.tags?.[d] || []);
    const rows = values.map((v, i) => ({ ...(Object.fromEntries(dims.map((d, k) => [d, labels[k][i]]))), value: v }));
    return { type: body.type, metric, rows };
  }
  const series = new Map();
  for (let i = 0; i < values.length; i++) {
    const label = dims.length ? dims.map(d => raw.tags?.[d]?.[i]).join(' | ') : 'all';
    if (!series.has(label)) series.set(label, []);
    series.get(label).push([ts[i], values[i]]);
  }
  const out = [];
  for (const [label, points] of series) {
    let pts = points;
    if (stepMs > 0) {
      const buckets = new Map();
      for (const [t, v] of points) {
        const b = Math.floor(t / stepMs) * stepMs;
        const acc = buckets.get(b) || { sum: 0, n: 0 };
        if (typeof v === 'number') { acc.sum += v; acc.n += 1; }
        buckets.set(b, acc);
      }
      pts = [...buckets].map(([t, a]) => [t, a.n ? +(a.sum / a.n).toFixed(3) : null]);
    }
    const nums = pts.map(p => p[1]).filter(v => typeof v === 'number');
    out.push({
      label, points: pts,
      summary: nums.length ? { n: nums.length, min: Math.min(...nums), max: Math.max(...nums), avg: +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3), last: nums[nums.length - 1] } : { n: 0 },
    });
  }
  return { type: 'timeseries', metric, stepMs: stepMs || (ts.length > 1 ? ts[1] - ts[0] : null), series: out };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      const v = inline !== undefined ? inline : (next !== undefined && !next.startsWith('--') ? argv[++i] : true);
      if (out[k] === undefined) out[k] = v; else out[k] = [].concat(out[k], v);
    } else out._.push(a);
  }
  return out;
}
const arr = v => v === undefined ? [] : [].concat(v);

function fmtTable(result) {
  if (result.type !== 'timeseries') {
    return result.rows.map(r => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  ')).join('\n');
  }
  const lines = [`metric: ${result.metric}  step: ${result.stepMs ? result.stepMs / 1000 + 's' : '?'}`];
  for (const s of result.series) {
    const { n, min, max, avg, last } = s.summary;
    lines.push(`\n[${s.label}] n=${n} min=${min} max=${max} avg=${avg} last=${last}`);
    for (const [t, v] of s.points) lines.push(`${new Date(t).toISOString()}  ${v}`);
  }
  return lines.join('\n');
}
function fmtCsv(result) {
  if (result.type !== 'timeseries') {
    const keys = Object.keys(result.rows[0] || {});
    return [keys.join(','), ...result.rows.map(r => keys.map(k => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
  }
  const lines = ['time,label,value'];
  for (const s of result.series) for (const [t, v] of s.points) lines.push(`${new Date(t).toISOString()},${JSON.stringify(s.label)},${v ?? ''}`);
  return lines.join('\n');
}

async function cli(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === 'metrics') {
    const data = await listMetrics({ collection: args.collection });
    if (args.json) return console.log(JSON.stringify(data, null, 2));
    for (const c of data.collections) {
      console.log(`\n## ${c.id} (${c.displayName})  dims: ${(c.dimensions || []).map(d => d.id).join(', ')}`);
      for (const m of c.metrics) console.log(`  ${m.id.padEnd(36)} ${m.aggregations.map(a => a.id).join(',')}`);
    }
    return;
  }
  if (cmd === 'query') {
    if (!args.metric) throw new Error('--metric is required');
    const result = await queryMetric({
      metric: args.metric, aggregation: args.agg, type: args.type,
      from: args.from, to: args.to, step: args.step,
      appIds: arr(args.app), dimensions: arr(args.dim), filters: arr(args.filter).map(parseFilter),
    });
    if (args.json) return console.log(JSON.stringify(result, null, 2));
    if (args.csv) return console.log(fmtCsv(result));
    return console.log(fmtTable(result));
  }
  if (cmd === 'mcp') return mcp();
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? 1 : 0;
}

// ---------- MCP (stdio, newline-delimited JSON-RPC) ----------
const TOOLS = [
  {
    name: 'list_metrics',
    description: 'List Monti APM metric collections (system, methods, pubs, http, jobs, errors) with their metrics, aggregations, dimensions and filters.',
    inputSchema: { type: 'object', properties: { collection: { type: 'string', description: 'Only this collection id, e.g. "system"' } } },
  },
  {
    name: 'query_metric',
    description: 'Query a Monti APM metric. type=timeseries returns 1-minute points (optionally downsampled with step); summary returns one aggregated value; breakdown returns one value per dimension value (e.g. per method name). Use dimensions ["tag:host"] for per-host/per-container series. Times accept ISO strings, epoch ms, or relative like "6h"/"7d". Default app ids come from MONTI_APP_ID.',
    inputSchema: {
      type: 'object', required: ['metric'],
      properties: {
        metric: { type: 'string', description: 'e.g. system.pcpu, system.memory, system.sessions, methods.total, pubs.activeSubs' },
        aggregation: { type: 'string', description: 'avg|max|min|sum|last|rate|perHost|p95... (see list_metrics)' },
        type: { type: 'string', enum: ['timeseries', 'summary', 'breakdown'], default: 'timeseries' },
        from: { type: 'string', description: 'start: ISO, epoch ms, or relative like "6h" (default 1h before to)' },
        to: { type: 'string', description: 'end: ISO, epoch ms, or "now" (default now)' },
        step: { type: 'string', description: 'client-side downsample bucket, e.g. "5m", "1h"' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["tag:host"] or ["tag:name"]' },
        filters: { type: 'array', items: { type: 'object', properties: { tagId: { type: 'string' }, operator: { type: 'string', enum: ['is', 'isNot', 'matchesRegex'] }, values: { type: 'array', items: { type: 'string' } } }, required: ['tagId', 'operator', 'values'] } },
        appIds: { type: 'array', items: { type: 'string' } },
        includePoints: { type: 'boolean', description: 'Include raw points (default true). Set false for summaries only.', default: true },
      },
    },
  },
];

async function callTool(name, a = {}) {
  if (name === 'list_metrics') return listMetrics({ collection: a.collection });
  if (name === 'query_metric') {
    const r = await queryMetric(a);
    if (a.includePoints === false && r.series) r.series = r.series.map(({ label, summary }) => ({ label, summary }));
    return r;
  }
  throw new Error(`Unknown tool ${name}`);
}

function mcp() {
  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let req; try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    if (id === undefined) return; // notification
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'montiapm-rest', version: '0.1.0' } } });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        try {
          const result = await callTool(params.name, params.arguments);
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
        } catch (e) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
        }
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('montiapm.mjs') || process.argv[1]?.endsWith('/montiapm')) {
  cli(process.argv.slice(2)).catch(e => { console.error(e.message || e); process.exit(1); });
}
