"""Async local CCR interface using its streaming CLI protocol (Python 3.10+)."""
import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator, Optional, Dict, Any

STREAM_LINE_LIMIT = 16 * 1024 * 1024


async def query(prompt: str, *, cwd: Optional[str] = None,
                env: Optional[Dict[str, str]] = None, model: Optional[str] = None,
                max_turns: int = 8, resume: Optional[str] = None) -> AsyncIterator[Dict[str, Any]]:
    cli = Path(__file__).resolve().parent.parent / "dist" / "cli.js"
    args = ["node", str(cli), "--print", "--input-format", "stream-json",
            "--output-format", "stream-json", "--max-turns", str(max_turns)]
    if resume:
        args.extend(["--resume", resume])
    config = dict(os.environ)
    config.update(env or {})
    if model:
        config["LLM_MODEL"] = model
    kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
    process = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=config,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, limit=STREAM_LINE_LIMIT, **kwargs)
    error_task = asyncio.create_task(process.stderr.read())
    try:
        process.stdin.write((json.dumps({"type": "user", "message": {
            "role": "user", "content": prompt}}) + "\n").encode("utf-8"))
        await process.stdin.drain()
        process.stdin.close()
    seen_result = False
    async for line in process.stdout:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            # A stray non-JSON line on stdout (a hook/tool printing directly,
            # a banner, a partial line after a kill) must not kill the CLI and
            # discard already-yielded messages — mirror the TS SDK's protocol
            # frame and keep reading.
            yield {"type": "system", "subtype": "non_json_stdout", "is_error": True,
                   "message": line[:2000]}
            continue
        seen_result |= message.get("type") == "result"
        yield message
    code = await process.wait()
    errors = await error_task
    # code None means WE (or the consumer) terminated the process — normal.
    if code not in (0, None):
        if not seen_result:
            raise RuntimeError("CCR exited {}: {}".format(code, errors[-8000:].decode("utf-8", "replace")))
        yield {"type": "system", "subtype": "abnormal_exit", "is_error": True,
               "message": "CCR exited {} after the result frame: {}".format(
                   code, errors[-500:].decode("utf-8", "replace"))}
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if not error_task.done():
            error_task.cancel()
