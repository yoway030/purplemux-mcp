// Shared stdio JSON-RPC transport for tests driving dist/index.js.
// Transport ONLY — spawn, line-buffered parser, pending map, auto-id rpc,
// initialize handshake. Watchdog timeouts, exit codes, assertion helpers,
// and content/text mapping deliberately stay in each test file (they differ
// per test on purpose — R2-D3 합의).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function createClient() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const srv = spawn('node', [path.join(root, 'dist/index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });

  let buf = '';
  const pending = new Map();
  srv.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });

  let idc = 0;
  const send = (obj) => srv.stdin.write(JSON.stringify(obj) + '\n');
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++idc;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
  const initialize = async (clientName) => {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return init;
  };

  return { srv, send, rpc, initialize, kill: () => srv.kill() };
}
