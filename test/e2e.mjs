// Live end-to-end test of the purplemux MCP server against the running server.
// Exercises the real tool round-trip + an error path. Cleans up its tab.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = process.env.PMUX_TEST_WS || 'ws-UJm6NN';
const srv = spawn('node', [path.join(root, 'dist/index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = ''; const pend = new Map();
srv.stdout.on('data', (d) => { buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
let idc = 0;
const send = (o) => srv.stdin.write(JSON.stringify(o) + '\n');
const rpc = (method, params) => new Promise((r) => { const id = ++idc; pend.set(id, r); send({ jsonrpc: '2.0', id, method, params }); });
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.result?.content || []).map((c) => c.text ?? `[${c.type}:${(c.data||'').length}b]`).join('');
  // rpcError = protocol-level rejection (e.g. Zod input validation -32602)
  return { isError: r.result?.isError === true, rpcError: r.error, text, raw: r.result };
};
const j = (t) => { try { return JSON.parse(t); } catch { return null; } };

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`); };

const main = async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 1. list_workspaces
  const ws = await call('pmux_list_workspaces');
  const wsj = j(ws.text);
  check('list_workspaces', !ws.isError && Array.isArray(wsj?.workspaces) && wsj.workspaces.length > 0);

  // 2. connection_info (no token leak)
  const ci = await call('pmux_connection_info');
  check('connection_info hasToken+no-leak', !ci.isError && j(ci.text)?.hasToken === true && !/[a-f0-9]{32}/.test(ci.text));

  // 3. api_guide is markdown
  const ag = await call('pmux_api_guide');
  check('api_guide markdown', !ag.isError && ag.text.includes('/api/cli/'));

  // 4. error path (schema): invalid panelType → rejected at Zod layer (JSON-RPC error), never hits server
  const bad = await call('pmux_create_tab', { workspaceId: WS, panelType: 'not-a-type' });
  check('create_tab invalid panelType → schema-rejected', (!!bad.rpcError || bad.isError) && /validation|invalid arguments/i.test((bad.rpcError?.message || '') + bad.text), (bad.rpcError?.message || bad.text).slice(0, 70));

  // 4b. error path (server): send to a bogus tabId → mapped 404 tool error
  const notfound = await call('pmux_send_input', { workspaceId: WS, tabId: 'tab-DOES-NOT-EXIST', content: 'x' });
  check('send bogus tab → 404 tool error', notfound.isError && j(notfound.text)?.status === 404, (j(notfound.text)?.error || '').slice(0, 60));

  // 5. create terminal tab
  const created = await call('pmux_create_tab', { workspaceId: WS, name: 'mcp-e2e', panelType: 'terminal' });
  const tabId = j(created.text)?.tabId;
  check('create_tab terminal', !created.isError && !!tabId, `tabId=${tabId}`);
  if (!tabId) { srv.kill(); return report(); }

  await new Promise((r) => setTimeout(r, 2500)); // shell init

  // 6. send_input WITHOUT newline (server auto-submits)
  const mark = 'E2EOK' + Math.floor(idc * 7 + 13);
  const sent = await call('pmux_send_input', { workspaceId: WS, tabId, content: `echo ${mark}` });
  check('send_input', !sent.isError && j(sent.text)?.status === 'sent');
  await new Promise((r) => setTimeout(r, 2500));

  // 7. capture_pane → command executed (mark appears as typed line + output ⇒ >=2)
  const cap = await call('pmux_capture_pane', { workspaceId: WS, tabId });
  const occ = (j(cap.text)?.content || '').split(mark).length - 1;
  check('capture_pane shows auto-submitted output', !cap.isError && occ >= 2, `occurrences=${occ}`);

  // 8. tab_status alive
  const st = await call('pmux_tab_status', { workspaceId: WS, tabId });
  check('tab_status alive', !st.isError && j(st.text)?.alive === true);

  // 9. get_tab
  const gt = await call('pmux_get_tab', { workspaceId: WS, tabId });
  check('get_tab', !gt.isError && j(gt.text)?.tabId === tabId);

  // 10. list_tabs includes it
  const lt = await call('pmux_list_tabs', { workspaceId: WS });
  check('list_tabs includes new tab', !lt.isError && (j(lt.text)?.tabs || []).some((t) => t.tabId === tabId));

  // 11. close_tab → real {ok:true}
  const cl = await call('pmux_close_tab', { workspaceId: WS, tabId });
  check('close_tab real {ok:true}', !cl.isError && j(cl.text)?.ok === true);

  srv.kill(); report();
};
const report = () => { console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
main().catch((e) => { console.error('E2E CRASH', e); srv.kill(); process.exit(2); });
setTimeout(() => { console.error('TIMEOUT'); srv.kill(); process.exit(3); }, 30000);
