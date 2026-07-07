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
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`); };

const main = async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 1. list_workspaces
  const ws = await call('pmux_list_workspaces');
  const wsj = j(ws.text);
  check('list_workspaces', !ws.isError && Array.isArray(wsj?.workspaces) && wsj.workspaces.length > 0);
  const workspace = (wsj?.workspaces || []).find((w) => w.id === WS || w.workspaceId === WS) || wsj?.workspaces?.[0];
  const workspaceDir = Array.isArray(workspace?.directories) ? workspace.directories[0] : undefined;
  check('workspace has directories[0]', typeof workspaceDir === 'string' && workspaceDir.length > 0, workspaceDir || '');

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

  // 4c. agent_start injection guard: model goes through ToolError, not the shell
  const badAgentStart = await call('pmux_agent_start', { workspaceId: WS, provider: 'codex', model: 'gpt-5; rm -rf /' });
  check('agent_start rejects injected model → ToolError', badAgentStart.isError && /model/i.test(j(badAgentStart.text)?.message || badAgentStart.text), (j(badAgentStart.text)?.message || badAgentStart.text).slice(0, 80));

  // 4d. real agent_start path: newly-created tab waits for shell before sending codex
  const liveStart = await call('pmux_agent_start', { workspaceId: WS, name: 'mcp-e2e-agent-start', provider: 'codex', sandbox: 'read-only', shellTimeoutMs: 10000 });
  const liveStartJ = j(liveStart.text);
  check('agent_start live codex returns command', !liveStart.isError && liveStartJ?.provider === 'codex' && typeof liveStartJ?.tabId === 'string' && typeof liveStartJ?.command === 'string' && liveStartJ.state !== 'not_shell_ready', (liveStartJ?.state || liveStartJ?.tabId || liveStart.text).slice(0, 100));
  if (!liveStart.isError && liveStartJ?.tabId) {
    const liveReady = await call('pmux_agent_wait_ready', { workspaceId: WS, tabId: liveStartJ.tabId, provider: 'codex', timeoutMs: 15000, pollMs: 1000 });
    const liveReadyJ = j(liveReady.text);
    check('agent_wait_ready live codex reached terminal state', !liveReady.isError && ['agent_ready', 'agent_busy', 'agent_starting', 'launch_failed', 'timeout', 'exited'].includes(liveReadyJ?.state), liveReadyJ?.state || liveReady.text.slice(0, 80));
    const liveClose = await call('pmux_close_tab', { workspaceId: WS, tabId: liveStartJ.tabId });
    check('close live agent_start tab', !liveClose.isError && j(liveClose.text)?.ok === true);
  }

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

  // 7b. fake agent marker round-trip via terminal printf → pmux_agent_capture
  const agentId = 'e2e_agent';
  const fake = await call('pmux_send_input', {
    workspaceId: WS,
    tabId,
    content: `printf '%s\\n' '<<<PMUX_BEGIN agent=${agentId} turn=1>>>' 'roundtrip-${mark}' '<<<PMUX_END agent=${agentId} turn=1>>>'`
  });
  check('fake agent printf send', !fake.isError && j(fake.text)?.status === 'sent');
  await new Promise((r) => setTimeout(r, 1500));
  const agentCap = await call('pmux_agent_capture', { workspaceId: WS, tabId, agentId, turn: 1 });
  const agentCapJ = j(agentCap.text);
  check('agent_capture fake marker complete', !agentCap.isError && agentCapJ?.status === 'complete' && agentCapJ.content.includes(`roundtrip-${mark}`), (agentCapJ?.status || agentCap.text).slice(0, 80));

  // 7c. v2.1 file report + DONE signal → capture source:file
  if (typeof workspaceDir === 'string' && workspaceDir.length > 0) {
    const reportDir = path.join(workspaceDir, '.pmux-agents', agentId);
    const fileReq = 'abcdef123456';
    const fileTurn = 2;
    const filePath = path.join(reportDir, `turn-${fileTurn}.md`);
    const writeComplete = [
      `mkdir -p ${sh(reportDir)}`,
      `printf '%s\\n' ${sh(`status=complete req=${fileReq}`)} ${sh(`file-content-${mark}`)} ${sh(`<<<PMUX_EOF req=${fileReq}>>>`)} > ${sh(filePath)}`,
      `printf '%s\\n' ${sh(`<<<PMUX_DONE agent=${agentId} turn=${fileTurn} req=${fileReq} status=complete>>>`)}`
    ].join(' && ');
    const wroteComplete = await call('pmux_send_input', { workspaceId: WS, tabId, content: writeComplete });
    check('write v2 report file + DONE', !wroteComplete.isError && j(wroteComplete.text)?.status === 'sent');
    await new Promise((r) => setTimeout(r, 1500));
    const fileCap = await call('pmux_agent_capture', { workspaceId: WS, tabId, agentId, turn: fileTurn, requestId: fileReq });
    const fileCapJ = j(fileCap.text);
    check('agent_capture v2 file complete', !fileCap.isError && fileCapJ?.status === 'complete' && fileCapJ.source === 'file' && fileCapJ.doneSignal === true && fileCapJ.content.includes(`file-content-${mark}`), (fileCapJ?.status || fileCap.text).slice(0, 100));

    const staleTurn = 3;
    const stalePath = path.join(reportDir, `turn-${staleTurn}.md`);
    const writeStale = [
      `mkdir -p ${sh(reportDir)}`,
      `printf '%s\\n' ${sh('status=complete req=111111111111')} ${sh(`stale-${mark}`)} ${sh('<<<PMUX_EOF req=111111111111>>>')} > ${sh(stalePath)}`
    ].join(' && ');
    await call('pmux_send_input', { workspaceId: WS, tabId, content: writeStale });
    await new Promise((r) => setTimeout(r, 1000));
    const staleCap = await call('pmux_agent_capture', { workspaceId: WS, tabId, agentId, turn: staleTurn, requestId: '222222222222' });
    const staleCapJ = j(staleCap.text);
    check('agent_capture stale req mismatch', !staleCap.isError && staleCapJ?.status === 'working' && staleCapJ.reason === 'stale_file_req_mismatch', (staleCapJ?.reason || staleCap.text).slice(0, 100));

    const midTurn = 4;
    const midReq = '333333333333';
    const midPath = path.join(reportDir, `turn-${midTurn}.md`);
    const writeMid = [
      `mkdir -p ${sh(reportDir)}`,
      `printf '%s\\n' ${sh(`status=complete req=${midReq}`)} ${sh(`midwrite-${mark}`)} > ${sh(midPath)}`
    ].join(' && ');
    await call('pmux_send_input', { workspaceId: WS, tabId, content: writeMid });
    await new Promise((r) => setTimeout(r, 1000));
    const midCap = await call('pmux_agent_capture', { workspaceId: WS, tabId, agentId, turn: midTurn, requestId: midReq });
    const midCapJ = j(midCap.text);
    check('agent_capture missing EOF still working', !midCap.isError && midCapJ?.status === 'working' && midCapJ.reason === 'file_invalid_or_midwrite', (midCapJ?.reason || midCap.text).slice(0, 100));

    const snap = await call('pmux_agent_status', { workspaceId: WS, tabId, provider: 'codex', agentId, turn: fileTurn, requestId: fileReq });
    const snapJ = j(snap.text);
    check('agent_status snapshot shape', !snap.isError && typeof snapJ?.alive === 'boolean' && typeof snapJ?.readiness?.state === 'string' && snapJ?.doneSignal?.found === true && snapJ?.reportFile?.exists === true && snapJ.reportFile.statusLine === 'complete' && snapJ.reportFile.reqMatch === true && snapJ.reportFile.eofPresent === true && typeof snapJ.tail === 'string', JSON.stringify(snapJ?.reportFile || {}).slice(0, 100));
  }

  // 7d. wait_ready detects a failed launch command in a terminal tab
  const noSuchCmd = await call('pmux_send_input', { workspaceId: WS, tabId, content: `definitely-not-a-command-${mark}` });
  check('send nonexistent command', !noSuchCmd.isError && j(noSuchCmd.text)?.status === 'sent');
  await new Promise((r) => setTimeout(r, 1500));
  const launchFailed = await call('pmux_agent_wait_ready', { workspaceId: WS, tabId, provider: 'codex', timeoutMs: 3000, pollMs: 500 });
  check('agent_wait_ready launch_failed', !launchFailed.isError && j(launchFailed.text)?.state === 'launch_failed', (j(launchFailed.text)?.state || launchFailed.text).slice(0, 80));

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
setTimeout(() => { console.error('TIMEOUT'); srv.kill(); process.exit(3); }, 45000);
