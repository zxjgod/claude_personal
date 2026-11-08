"""Self-contained protocol tests for ccr_sdk (run: python python/test_ccr_sdk.py).

Uses a Node fixture CLI speaking the stream-json control protocol, so no
model provider or built dist is required. Node must be on PATH.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ccr_sdk import query

PERMISSION_FIXTURE = """import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    console.log(JSON.stringify({type:'control_request',request_id:'perm-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'ls'},permission_suggestions:[]}}));
  } else if (msg.type === 'control_response') {
    console.log(JSON.stringify({type:'result',session_id:'fixture',result:JSON.stringify(msg.response.response ?? msg.response)}));
  }
}
"""

PLAIN_FIXTURE = """import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    console.log(JSON.stringify({type:'result',session_id:'fixture',result:msg.message.content}));
  }
}
"""


class SdkProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_permission_roundtrip(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Path(root) / "fixture.mjs"
            fixture.write_text(PERMISSION_FIXTURE, encoding="utf-8")
            seen = []

            async def allow(tool_name, tool_input, context):
                seen.append((tool_name, tool_input))
                return {"behavior": "allow", "updatedInput": {"command": "pwd"}}

            messages = [m async for m in query(
                "go", cwd=root, cli=str(fixture), can_use_tool=allow)]
            self.assertEqual(seen, [("Bash", {"command": "ls"})])
            self.assertFalse(any(m.get("type") in ("control_request", "control_response")
                                 for m in messages))
            result = next(m for m in messages if m.get("type") == "result")
            self.assertEqual(json.loads(result["result"]),
                             {"behavior": "allow", "updatedInput": {"command": "pwd"}})

    async def test_callback_error_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Path(root) / "fixture.mjs"
            fixture.write_text(PERMISSION_FIXTURE, encoding="utf-8")

            async def explode(tool_name, tool_input, context):
                raise RuntimeError("callback exploded")

            messages = [m async for m in query(
                "go", cwd=root, cli=str(fixture), can_use_tool=explode)]
            result = next(m for m in messages if m.get("type") == "result")
            frame = json.loads(result["result"])
            self.assertEqual(frame["subtype"], "error")
            self.assertIn("callback exploded", frame["error"])

    async def test_plain_query_without_callback(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Path(root) / "fixture.mjs"
            fixture.write_text(PLAIN_FIXTURE, encoding="utf-8")
            messages = [m async for m in query("hello", cwd=root, cli=str(fixture))]
            result = next(m for m in messages if m.get("type") == "result")
            self.assertEqual(result["result"], "hello")


if __name__ == "__main__":
    unittest.main()