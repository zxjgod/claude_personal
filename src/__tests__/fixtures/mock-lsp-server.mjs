let buffer = Buffer.alloc(0);
const send = (value) => { const body = JSON.stringify(value); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n"); if (boundary < 0) return;
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString())[1]);
    if (buffer.length < boundary + 4 + size) return;
    const value = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + size).toString()); buffer = buffer.subarray(boundary + 4 + size);
    if (value.id !== undefined) send({ jsonrpc: "2.0", id: value.id, result: value.method === "initialize" ? { capabilities: { definitionProvider: true } } : [{ uri: value.params.textDocument.uri, range: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } } }] });
    if (value.method === "textDocument/didOpen") send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: value.params.textDocument.uri, diagnostics: [] } });
  }
});
