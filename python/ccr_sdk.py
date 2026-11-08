"""Async local CCR interface using its streaming CLI protocol (Python 3.10+)."""
import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable, Optional, Dict, Any

STREAM_LINE_LIMIT = 16 * 1024 * 1024

# async (tool_name, input, context) -> {"behavior": "allow", "updatedInput": ...}
#                                  or {"behavior": "deny", "message": ..., "interrupt": ...}
CanUseTool = Callable[[str, Dict[str, Any], Dict[str, Any]], Awaitable[Dict[str, Any]]]


async def _send_frame(process, frame: Dict[str, Any]) -> None:
    """Best-effort frame write. A closed stdin (EOF) makes the CLI fail every
    parked ask closed, so a dropped response here is safe — never raise."""
    if process.stdin is None or process.stdin.is_closing():
        return
    try:
        process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        await process.stdin.drain()
    except (ConnectionError, OSError):
        pass  # stdin already closed — the CLI denies parked asks on EOF


async def _answer_permission(process, can_use_tool: CanUseTool,
                             request: Dict[str, Any], request_id: Any) -> None:
    try:
        decision = await can_use_tool(
            request.get("tool_name", ""), request.get("input") or {},
            {"suggestions": request.get("permission_suggestions") or []})
        frame = {"type": "control_response", "response": {
            "subtype": "success", "request_id": request_id, "response": decision}}
    except Exception as error:  # callback failure fails closed on the CLI side
        frame = {"type": "control_response", "response": {
            "subtype": "error", "request_id": request_id, "error": str(error)}}
    await _send_frame(process, frame)


async def query(prompt: str, *, cwd: Optional[str] = None,
                env: Optional[Dict[str, str]] = None, model: Optional[str] = None,
                max_turns: int = 8, resume: Optional[str] = None,
                can_use_tool: Optional[CanUseTool] = None,
                cli: Optional[str] = None) -> AsyncIterator[Dict[str, Any]]:
    cli_path = Path(cli) if cli else Path(__file__).resolve().parent.parent / "dist" / "cli.js"
    args = ["node", str(cli_path), "--print", "--input-format", "stream-json",
            "--output-format", "stream-json", "--max-turns", str(max_turns)]
    if resume:
        args.extend(["--resume", resume])
    if can_use_tool is not None:
        args.extend(["--permission-prompt-tool", "stdio"])
    config = dict(os.environ)
    config.update(env or {})
    if model:
        config["LLM_MODEL"] = model
    kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
    process = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=config,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, limit=STREAM_LINE_LIMIT, **kwargs)
    error_task = asyncio.create_task(process.stderr.read())
    permission_tasks: set = set()
    try:
        process.stdin.write((json.dumps({"type": "user", "message": {
            "role": "user", "content": prompt}}) + "\n").encode("utf-8"))
        await process.stdin.drain()
        # With a permission callback stdin must outlive the prompt: approval
        # responses write mid-turn. Close it once the result frame arrives.
        if can_use_tool is None:
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
            kind = message.get("type")
            if kind == "control_request":
                request = message.get("request") or {}
                request_id = message.get("request_id")
                if request.get("subtype") == "can_use_tool" and can_use_tool is not None:
                    # Do not await: a slow callback must not block the read loop.
                    task = asyncio.create_task(_answer_permission(
                        process, can_use_tool, request, request_id))
                    permission_tasks.add(task)
                    task.add_done_callback(permission_tasks.discard)
                else:
                    await _send_frame(process, {"type": "control_response", "response": {
                        "subtype": "error", "request_id": request_id,
                        "error": "Unsupported control request: {}".format(request.get("subtype"))}})
                continue
            if kind == "control_response":
                continue  # SDK plumbing, not a conversation message
            if kind == "result":
                seen_result = True
                if can_use_tool is not None:
                    process.stdin.close()
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
        for task in permission_tasks:
            task.cancel()
        if permission_tasks:
            # Wait out the cancellations so no "Task was destroyed but it is
            # pending" warning fires at loop shutdown; bounded like the
            # terminate wait below.
            await asyncio.wait(permission_tasks, timeout=5)
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if not error_task.done():
            error_task.cancel()
