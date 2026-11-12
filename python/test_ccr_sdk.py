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

    async def test_noise_and_invalid_envelopes_are_serializable_diagnostics(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Path(root) / "fixture.mjs"
            fixture.write_text("""import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  if (JSON.parse(line).type==='user') {
    console.log('diagnostic');
    for(const value of [null,[],"banner",{foo:"bar"}]) console.log(JSON.stringify(value));
    console.log(JSON.stringify({type:'result',result:'survived'}));
  }
}
""", encoding="utf-8")
            messages = [message async for message in query("go", cwd=root, cli=str(fixture))]
            json.dumps(messages)
            noise = next(message for message in messages if message.get("subtype") == "non_json_stdout")
            self.assertIsInstance(noise["message"], str)
            self.assertEqual(sum(message.get("subtype") == "invalid_protocol_message" for message in messages), 4)
            self.assertEqual(messages[-1]["result"], "survived")

    async def test_result_cancels_a_pending_permission_before_consumer_resumes(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Path(root) / "fixture.mjs"
            fixture.write_text("""import fs from 'node:fs';
import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg=JSON.parse(line);
  if (msg.type==='user') {
    console.log(JSON.stringify({type:'control_request',request_id:'p',request:{subtype:'can_use_tool',tool_name:'Write',input:{}}}));
    const poll=setInterval(()=>{if(fs.existsSync('callback-started')) {
      clearInterval(poll); console.log(JSON.stringify({type:'result',result:'ended'}));
    }},5);
  }
}
""", encoding="utf-8")
            cancelled = asyncio.Event()

            async def pending(tool_name, tool_input, context):
                Path(root, "callback-started").write_text("ready", encoding="utf-8")
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

            stream = query("go", cwd=root, cli=str(fixture), can_use_tool=pending)
            try:
                message = await asyncio.wait_for(anext(stream), timeout=10)
                self.assertEqual(message["type"], "result")
                # Let task cancellation run while the query generator stays
                # paused at yield, before aclose performs final cleanup.
                await asyncio.sleep(0)
                self.assertTrue(cancelled.is_set())
            finally:
                await stream.aclose()


if __name__ == "__main__":
    unittest.main()
