// Minimal stdio MCP client smoke test against dist/index.js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn('node', [path.join(root, 'dist/index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const send = (obj) => srv.stdin.write(JSON.stringify(obj) + '\n');
const rpc = (id, method, params) => new Promise((res) => { pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });

// Handshake/tool-list failures must fail the run (CI gate); the live
// pmux_list_workspaces call is allowed to be isError (no purplemux needed).
const EXPECTED_TOOL_COUNT = 23;
let failed = false;
const expect = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error(`SMOKE ASSERT FAIL: ${msg}`);
  }
};

const main = async () => {
  const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  console.log('INIT ok:', !!init.result, 'server:', init.result?.serverInfo?.name);
  expect(!!init.result, 'initialize returned no result');
  expect(typeof init.result?.instructions === 'string' && init.result.instructions.length > 0, 'initialize result carries no instructions');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await rpc(2, 'tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  console.log('TOOL COUNT:', names.length);
  console.log('TOOLS:', names.join(', '));
  expect(names.length === EXPECTED_TOOL_COUNT, `expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}`);
  const call = await rpc(3, 'tools/call', { name: 'pmux_list_workspaces', arguments: {} });
  const txt = (call.result?.content || []).map((c) => c.text || `[${c.type}]`).join('');
  console.log('list_workspaces isError:', call.result?.isError === true);
  console.log('list_workspaces content (head):', txt.slice(0, 300));
  const ci = await rpc(4, 'tools/call', { name: 'pmux_connection_info', arguments: {} });
  console.log('connection_info:', (ci.result?.content || []).map((c) => c.text).join('').slice(0, 200));
  srv.kill();
  process.exit(failed ? 1 : 0);
};
main().catch((e) => { console.error('SMOKE FAIL', e); srv.kill(); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); srv.kill(); process.exit(2); }, 15000);
