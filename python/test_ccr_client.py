"""Persistent client contract tests; Node fixture, no model credentials needed."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ccr_sdk import CCRClient, _pid_running


FIXTURE = """import readline from 'node:readline';
let model='initial',mode='default',history=[],active=false;
const emit=(value)=>console.log(JSON.stringify(value));
const result=(value,extra={})=>{active=false;emit({type:'result',session_id:'persistent',result:value,...extra});};
for await(const line of readline.createInterface({input:process.stdin})) {
  const msg=JSON.parse(line);
  if(msg.type==='user') {
    const text=msg.message.content;history.push(text);active=true;
    if(text==='hang') emit({type:'assistant',message:{content:'working'}});
    else if(text==='permission') emit({type:'control_request',request_id:'approval-'+history.length,request:{subtype:'can_use_tool',tool_name:'Write',input:{content:text},permission_suggestions:[]}});
    else if(text==='fail') result('task failed',{is_error:true});
    else if(text==='exit') process.exit(7);
    else if(text==='empty-exit') process.exit(0);
    else if(text==='stderr') {
      process.stderr.write('x'.repeat(100000)+'tail-marker');process.exit(9);
    }
    else if(text==='abnormal') {result('partial');process.exit(8);}
    else if(text==='malformed') {
      console.log('banner');console.log('null');
      emit({type:'control_request',request_id:'bad',request:[]});
      emit({type:'control_response',response:'bad'});
      result('survived');
    } else result(JSON.stringify({text,model,mode,history,pid:process.pid}));
  } else if(msg.type==='control_request') {
    const req=msg.request;
    if(req.model==='never-reply') continue;
    const subtype=req.model==='invalid-reply'?'unexpected':'success';
    emit({type:'control_response',response:{subtype,request_id:msg.request_id,response:{}}});
    if(req.subtype==='set_model') model=req.model;
    if(req.subtype==='set_permission_mode') mode=req.mode;
    if(req.subtype==='interrupt'&&active) result('interrupted',{is_error:true});
  } else if(msg.type==='control_response'&&msg.response.request_id.startsWith('approval-')) {
    if(active) result(JSON.stringify(msg.response));
    else emit({type:'system',subtype:'late_approval'});
  }
}
"""


class ClientProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_pid_probe_is_read_only_and_recognizes_process_exit(self):
        for exit_code in (0, 259):
            process = await asyncio.create_subprocess_exec(
                "node", "-e", "console.log('ready');process.stdin.on('data',()=>process.exit(Number(process.argv[1])))", str(exit_code),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            try:
                await asyncio.wait_for(process.stdout.readline(), timeout=5)
                self.assertTrue(_pid_running(process.pid))
                await asyncio.sleep(.05)
                self.assertIsNone(process.returncode)
                self.assertTrue(_pid_running(process.pid))
                process.stdin.write(b"exit\n")
                await process.stdin.drain()
                process.stdin.close()
                await process.wait()
                self.assertFalse(_pid_running(process.pid))
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name
        self.fixture = Path(self.root, "fixture.mjs")
        self.fixture.write_text(FIXTURE, encoding="utf-8")

    async def asyncTearDown(self):
        self.directory.cleanup()

    def client(self, **kwargs):
        return CCRClient(cli=str(self.fixture), cwd=self.root, **kwargs)

    async def response(self, client):
        return await asyncio.wait_for(self.collect(client.receive_response()), timeout=10)

    async def collect(self, stream):
        return [message async for message in stream]

    async def test_same_process_continues_after_task_failure_and_setting_changes(self):
        async with self.client() as client:
            await client.query("first")
            first = json.loads((await self.response(client))[-1]["result"])
            await client.query("fail")
            self.assertTrue((await self.response(client))[-1]["is_error"])
            await client.set_model("third-party-model")
            await client.set_permission_mode("plan")
            await client.query("next")
            last = json.loads((await self.response(client))[-1]["result"])
            self.assertEqual(first["pid"], last["pid"])
            self.assertEqual(last["history"], ["first", "fail", "next"])
            self.assertEqual((last["model"], last["mode"]), ("third-party-model", "plan"))

    async def test_interrupt_rpc_works_while_response_consumer_is_paused(self):
        async with self.client() as client:
            await client.query("hang")
            stream = client.receive_response()
            try:
                self.assertEqual((await anext(stream))["type"], "assistant")
                await asyncio.wait_for(client.interrupt(), timeout=2)
                remaining = await self.collect(stream)
                self.assertEqual(remaining[-1]["result"], "interrupted")
            finally:
                await stream.aclose()
            await client.query("after-interrupt")
            self.assertIn("after-interrupt", (await self.response(client))[-1]["result"])

    async def test_approval_callback_runs_without_consuming_messages(self):
        seen = []

        async def allow(name, payload, context):
            seen.append((name, payload, context))
            return {"behavior": "allow", "updatedInput": {"content": "approved"}}

        async with self.client(can_use_tool=allow) as client:
            await client.query("permission")
            # Control replies are serviced by the reader while the caller awaits RPC.
            await client.set_model("next-model")
            messages = await self.response(client)
            frame = json.loads(messages[-1]["result"])
            self.assertEqual(frame["response"]["updatedInput"], {"content": "approved"})
            self.assertEqual(seen[0][0], "Write")
            self.assertEqual(len(seen), 1)
            self.assertFalse(any(message["type"].startswith("control_") for message in messages))

    async def test_interrupted_approval_is_cancelled_and_next_approval_works(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        calls = 0

        async def approve(name, payload, context):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    # A callback swallowing cancellation must not send stale approval.
                    return {"behavior": "allow"}
            return {"behavior": "deny", "message": "second turn"}

        async with self.client(can_use_tool=approve) as client:
            await client.query("permission")
            await asyncio.wait_for(started.wait(), timeout=5)
            await client.interrupt()
            self.assertEqual((await self.response(client))[-1]["result"], "interrupted")
            await asyncio.wait_for(cancelled.wait(), timeout=2)
            await client.query("permission")
            messages = await self.response(client)
            self.assertFalse(any(message.get("subtype") == "late_approval" for message in messages))
            self.assertEqual(json.loads(messages[-1]["result"])["response"]["behavior"], "deny")

    async def test_rpc_timeout_and_invalid_reply_leave_session_usable(self):
        # Also runs alongside real CLI tests: leave startup/scheduling headroom
        # while still requiring an unresponsive RPC to time out and recover.
        async with self.client(control_timeout=2) as client:
            with self.assertRaisesRegex(TimeoutError, "set_model"):
                await client.set_model("never-reply")
            with self.assertRaisesRegex(RuntimeError, "subtype"):
                await client.set_model("invalid-reply")
            await client.set_model("recovered")
            await client.query("ready")
            self.assertEqual(json.loads((await self.response(client))[-1]["result"])["model"], "recovered")

    async def test_malformed_nested_frames_are_diagnostics_and_reading_continues(self):
        async with self.client() as client:
            await client.query("malformed")
            messages = await self.response(client)
            self.assertEqual(messages[-1]["result"], "survived")
            self.assertEqual(sum(message.get("subtype") == "invalid_protocol_message" for message in messages), 3)
            json.dumps(messages)

    async def test_disconnect_rejects_pending_rpc_and_waits_for_process_exit(self):
        client = self.client()
        await client.connect()
        process = client._process
        request = asyncio.create_task(client.set_model("never-reply"))
        await asyncio.sleep(0)
        await client.disconnect()
        with self.assertRaisesRegex(RuntimeError, "closed"):
            await request
        self.assertIsNotNone(process.returncode)
        await client.disconnect()
        with self.assertRaisesRegex(RuntimeError, "connect|closed"):
            await client.query("late")

    async def test_disconnect_allows_cli_eof_cleanup_before_termination(self):
        self.fixture.write_text(FIXTURE + """
await new Promise(resolve=>setTimeout(resolve,50));
const fs=await import('node:fs');
fs.writeFileSync('graceful-exit','finished');
""", encoding="utf-8")
        async with self.client() as client:
            await client.query("done")
            await self.response(client)
        self.assertEqual(Path(self.root, "graceful-exit").read_text(), "finished")

    async def test_disconnect_escalates_when_cli_ignores_eof_and_sigterm(self):
        self.fixture.write_text("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n" + FIXTURE, encoding="utf-8")
        async with self.client() as client:
            await client.query("done")
            await self.response(client)
            process = client._process
        self.assertIsNotNone(process.returncode)

    async def test_disconnect_does_not_drain_queued_work_when_results_are_pending(self):
        self.fixture.write_text("""import fs from 'node:fs';import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})) {
  console.log(JSON.stringify({type:'assistant',message:{content:'working'}}));
}
fs.writeFileSync('queued-effect','executed after cancellation');
""", encoding="utf-8")
        async with self.client() as client:
            await client.query("first")
            await client.query("queued")
            messages = client.receive_messages()
            try:
                await asyncio.wait_for(anext(messages), timeout=5)
            finally:
                await messages.aclose()
        self.assertFalse(Path(self.root, "queued-effect").exists())

    async def test_multiple_queued_queries_finish_input_after_all_results(self):
        async with self.client() as client:
            await client.query("one")
            await client.query("two")
            await client.finish()
            messages = await asyncio.wait_for(self.collect(client.receive_messages()), timeout=10)
            results = [json.loads(message["result"])["text"] for message in messages if message["type"] == "result"]
            self.assertEqual(results, ["one", "two"])

    async def test_process_failure_reaches_consumer_and_pending_controls(self):
        async with self.client() as client:
            pending = asyncio.create_task(client.set_model("never-reply"))
            await asyncio.sleep(0)
            await client.query("exit")
            with self.assertRaisesRegex(RuntimeError, "exited 7"):
                await self.response(client)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                await pending

    async def test_success_result_followed_by_bad_exit_emits_diagnostic(self):
        async with self.client() as client:
            await client.query("abnormal")
            messages = await asyncio.wait_for(self.collect(client.receive_messages()), timeout=10)
            self.assertEqual(messages[0]["result"], "partial")
            self.assertEqual(messages[-1]["subtype"], "abnormal_exit")

    async def test_clean_exit_with_missing_result_is_not_silent_success(self):
        async with self.client() as client:
            await client.query("empty-exit")
            with self.assertRaisesRegex(RuntimeError, "before all query results"):
                await self.response(client)

    async def test_stderr_is_drained_but_only_tail_is_retained(self):
        async with self.client() as client:
            await client.query("stderr")
            with self.assertRaisesRegex(RuntimeError, "tail-marker") as caught:
                await self.response(client)
            self.assertLess(len(str(caught.exception)), 8100)

    async def test_competing_consumer_is_rejected_without_stealing_the_response(self):
        async with self.client() as client:
            await client.query("hang")
            first = client.receive_response()
            try:
                self.assertEqual((await anext(first))["type"], "assistant")
                other = client.receive_response()
                with self.assertRaisesRegex(RuntimeError, "one message consumer"):
                    await anext(other)
                await client.interrupt()
                self.assertEqual((await self.collect(first))[-1]["result"], "interrupted")
            finally:
                await first.aclose()


if __name__ == "__main__":
    unittest.main()
