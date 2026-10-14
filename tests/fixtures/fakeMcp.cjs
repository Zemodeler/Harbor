// A stand-in MCP server over stdio (newline-delimited JSON-RPC), for testMcpServer. `--silent` never answers; `--error` refuses
// initialize. It prints its FAKE_TOKEN to stderr, so tests can check that Harbor masks entered env values.
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stderr.write(`starting with token=${process.env.FAKE_TOKEN ?? 'none'}\n`);
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (args.includes('--silent')) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      if (args.includes('--error')) out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'not today' } });
      else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.2.3' } } });
    } else if (m.method === 'tools/list') {
      out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }, { name: process.env.FAKE_TOKEN ? 'token_seen' : 'no_token', inputSchema: { type: 'object' } }, { name: process.env.SECRET_FROM_HARBOR ? 'leaked_env' : 'clean_env', inputSchema: { type: 'object' } }] } });
    }
  }
});
setInterval(() => {}, 1000);
