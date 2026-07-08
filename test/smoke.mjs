// Minimal stdio MCP client smoke test against dist/index.js
import { createClient } from './lib/mcp-client.mjs';

const { srv, rpc, initialize } = createClient();

// Handshake/tool-list failures must fail the run (CI gate); the live
// pmux_list_workspaces call is allowed to be isError (no purplemux needed).
// EXPECTED_TOOL_COUNT is a deliberate gate: adding/removing a tool MUST
// touch this number so the change is a conscious decision, not drift.
const EXPECTED_TOOL_COUNT = 23;
let failed = false;
const expect = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error(`SMOKE ASSERT FAIL: ${msg}`);
  }
};

const main = async () => {
  const init = await initialize('smoke');
  console.log('INIT ok:', !!init.result, 'server:', init.result?.serverInfo?.name);
  expect(!!init.result, 'initialize returned no result');
  expect(typeof init.result?.instructions === 'string' && init.result.instructions.length > 0, 'initialize result carries no instructions');
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  console.log('TOOL COUNT:', names.length);
  console.log('TOOLS:', names.join(', '));
  expect(names.length === EXPECTED_TOOL_COUNT, `expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}`);
  const call = await rpc('tools/call', { name: 'pmux_list_workspaces', arguments: {} });
  const txt = (call.result?.content || []).map((c) => c.text || `[${c.type}]`).join('');
  console.log('list_workspaces isError:', call.result?.isError === true);
  console.log('list_workspaces content (head):', txt.slice(0, 300));
  const ci = await rpc('tools/call', { name: 'pmux_connection_info', arguments: {} });
  console.log('connection_info:', (ci.result?.content || []).map((c) => c.text).join('').slice(0, 200));
  srv.kill();
  process.exit(failed ? 1 : 0);
};
main().catch((e) => { console.error('SMOKE FAIL', e); srv.kill(); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); srv.kill(); process.exit(2); }, 15000);
