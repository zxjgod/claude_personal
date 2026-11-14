"""Async local CCR interface using its streaming CLI protocol (Python 3.10+)."""
import asyncio
import json
import os
import re
import signal
from collections import deque
from pathlib import Path
from typing import AsyncIterator, Awaitable, Callable, Optional, Dict, Any
from uuid import uuid4

STREAM_LINE_LIMIT = 16 * 1024 * 1024
CanUseTool = Callable[[str, Dict[str, Any], Dict[str, Any]], Awaitable[Dict[str, Any]]]
_END = object()


def _pid_running(pid: int) -> bool:
    if os.name == "nt":
        # os.kill(pid, 0) is not a read-only Windows probe in Python.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() not in (87, 1168)
        try:
            return kernel.WaitForSingleObject(handle, 0) != 0
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class CCRClient:
    """One persistent local CLI session. Use ``async with`` to own its lifetime.

    ``query`` queues a turn; ``receive_response`` reads through its result.
    A background reader services approvals and RPCs independently of consumers.
    Only one message iterator may be active at a time. After ``finish`` no new
    prompts are accepted; stdin closes once every queued turn has a result.
    A disconnected client is terminal: create another client to reconnect.
    """

    def __init__(self, *, cwd: Optional[str] = None,
                 env: Optional[Dict[str, str]] = None, model: Optional[str] = None,
                 max_turns: int = 8, resume: Optional[str] = None,
                 can_use_tool: Optional[CanUseTool] = None,
                 cli: Optional[str] = None, control_timeout: float = 60):
        if control_timeout <= 0:
            raise ValueError("control_timeout must be positive")
        self._cwd, self._env, self._model = cwd, env, model
        self._max_turns, self._resume = max_turns, resume
        self._can_use_tool, self._cli = can_use_tool, cli
        self._control_timeout = control_timeout
        self._process = None
        self._reader_task = None
        self._stderr_task = None
        self._stderr = b""
        self._messages = asyncio.Queue()
        self._pending = {}
        self._permissions = {}
        self._sequence = 0
        self._epoch = 0
        self._sent = 0
        self._results = 0
        self._pending_inputs = deque()
        self._finished_input = False
        self._closing = False
        self._closed = False
        self._reader_done = False
        self._receiving = False
        self._failure = None

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        await self.disconnect()

    async def connect(self) -> None:
        if self._process is not None or self._closed:
            raise RuntimeError("CCR client already connected or closed")
        cli_path = Path(self._cli) if self._cli else Path(__file__).resolve().parent.parent / "dist" / "cli.js"
        args = ["node", str(cli_path), "--print", "--input-format", "stream-json",
                "--output-format", "stream-json", "--max-turns", str(self._max_turns)]
        if self._resume:
            args.extend(["--resume", self._resume])
        if self._can_use_tool is not None:
            args.extend(["--permission-prompt-tool", "stdio"])
        config = dict(os.environ)
        config.update(self._env or {})
        if self._model:
            config["LLM_MODEL"] = self._model
        kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}
        self._process = await asyncio.create_subprocess_exec(
            *args, cwd=self._cwd, env=config, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=STREAM_LINE_LIMIT, **kwargs)
        self._stderr_task = asyncio.create_task(self._read_stderr())
        self._reader_task = asyncio.create_task(self._read())

    def _require_open(self) -> None:
        if self._process is None or self._closing or self._closed or self._reader_done:
            raise RuntimeError("CCR client is not connected or is closed")

    def _send_frame(self, frame):
        self._require_open()
        stream = self._process.stdin
        if stream.is_closing():
            raise RuntimeError("CLI stdin is closed")
        try:
            stream.write((json.dumps(frame) + "\n").encode("utf-8"))
        except (ConnectionError, OSError) as error:
            raise RuntimeError("CLI stdin is closed") from error
        return stream

    async def _drain(self, stream) -> None:
        try:
            await stream.drain()
        except (ConnectionError, OSError) as error:
            raise RuntimeError("CLI stdin is closed") from error

    async def _write(self, frame) -> None:
        await self._drain(self._send_frame(frame))

    async def query(self, prompt: str) -> None:
        self._require_open()
        if self._finished_input:
            raise RuntimeError("CCR input is already finished")
        if not isinstance(prompt, str):
            raise TypeError("prompt must be a string")
        input_id = str(uuid4())
        stream = self._send_frame({"type": "user", "input_id": input_id,
                                   "message": {"role": "user", "content": prompt}})
        # Once write() accepts the frame, cancelling drain() cannot unsend it.
        self._pending_inputs.append(input_id)
        self._sent += 1
        await self._drain(stream)

    async def finish(self) -> None:
        """Declare input exhausted; keep control/approval writes alive until results."""
        self._require_open()
        self._finished_input = True
        self._maybe_close_input()

    def _maybe_close_input(self) -> None:
        if self._finished_input and self._results >= self._sent:
            self._process.stdin.close()

    async def _control(self, request) -> None:
        self._require_open()
        self._sequence += 1
        request_id = "python-{}".format(self._sequence)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({"type": "control_request", "request_id": request_id, "request": request})
            try:
                await asyncio.wait_for(future, timeout=self._control_timeout)
            except asyncio.TimeoutError as error:
                raise TimeoutError("Control request {} timed out".format(request["subtype"])) from error
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def interrupt(self) -> None:
        """Interrupt the active turn; its result remains in the message stream."""
        await self._control({"subtype": "interrupt"})

    async def set_model(self, model: str) -> None:
        await self._control({"subtype": "set_model", "model": model})

    async def set_permission_mode(self, mode: str) -> None:
        await self._control({"subtype": "set_permission_mode", "mode": mode})

    async def receive_messages(self) -> AsyncIterator[Dict[str, Any]]:
        """Read messages until CLI exit; errors propagate after queued messages."""
        if self._process is None:
            raise RuntimeError("CCR client is not connected")
        if self._receiving:
            raise RuntimeError("Only one message consumer may be active")
        self._receiving = True
        try:
            while True:
                message = await self._messages.get()
                if message is _END:
                    self._messages.put_nowait(_END)
                    if self._failure:
                        raise self._failure
                    return
                yield message
        finally:
            self._receiving = False

    async def receive_response(self) -> AsyncIterator[Dict[str, Any]]:
        """Read one response through its result; fully consume or close the iterator."""
        stream = self.receive_messages()
        try:
            async for message in stream:
                yield message
                if message["type"] == "result":
                    return
        finally:
            await stream.aclose()

    async def _read_stderr(self) -> None:
        while True:
            chunk = await self._process.stderr.read(8192)
            if not chunk:
                return
            self._stderr = (self._stderr + chunk)[-8000:]

    def _diagnostic(self, subtype, text) -> None:
        self._messages.put_nowait({"type": "system", "subtype": subtype,
                                   "is_error": True, "message": text[:2000]})

    def _cancel_permissions(self) -> None:
        self._epoch += 1
        for task in self._permissions.values():
            task.cancel()

    async def _answer_permission(self, request_id, request, epoch) -> None:
        try:
            try:
                decision = await self._can_use_tool(
                    request.get("tool_name", ""), request.get("input") or {},
                    {"suggestions": request.get("permission_suggestions") or []})
                response = {"subtype": "success", "request_id": request_id, "response": decision}
            except Exception as error:
                response = {"subtype": "error", "request_id": request_id, "error": str(error)}
            # Cancellation is cooperative. Even a callback swallowing CancelledError
            # must not send a stale approval into a later turn.
            if epoch == self._epoch and not self._closing:
                try:
                    await self._write({"type": "control_response", "response": response})
                except RuntimeError:
                    pass  # EOF denies parked asks on the CLI side.
        finally:
            self._permissions.pop(request_id, None)

    async def _handle_control(self, message, text) -> None:
        if message["type"] == "control_response":
            response = message.get("response")
            if not isinstance(response, dict) or not isinstance(response.get("request_id"), str):
                self._diagnostic("invalid_protocol_message", text)
                return
            future = self._pending.get(response["request_id"])
            if future is not None and not future.done():
                subtype = response.get("subtype")
                if subtype == "success":
                    future.set_result(response.get("response"))
                elif subtype == "error":
                    future.set_exception(RuntimeError(str(response.get("error", "Control request failed"))))
                else:
                    future.set_exception(RuntimeError("Invalid control response subtype: {}".format(subtype)))
            return
        request, request_id = message.get("request"), message.get("request_id")
        if not isinstance(request, dict) or not isinstance(request_id, str) or not request_id:
            self._diagnostic("invalid_protocol_message", text)
            return
        if request_id in self._permissions:
            self._diagnostic("invalid_protocol_message", "Duplicate approval request: " + request_id)
            return
        if request.get("subtype") == "can_use_tool" and self._can_use_tool is not None:
            self._permissions[request_id] = asyncio.create_task(
                self._answer_permission(request_id, request, self._epoch))
        else:
            await self._write({"type": "control_response", "response": {
                "subtype": "error", "request_id": request_id,
                "error": "Unsupported control request: {}".format(request.get("subtype"))}})

    def _reject_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RuntimeError("CLI closed before control response"))

    async def _read(self) -> None:
        expects_input_ids = False
        session_failed = False
        legacy_result_uuids = set()
        try:
            async for line in self._process.stdout:
                text = line.decode("utf-8", "replace")
                if not text.strip():
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    self._diagnostic("non_json_stdout", text)
                    continue
                if not isinstance(message, dict) or not isinstance(message.get("type"), str) or not message["type"]:
                    self._diagnostic("invalid_protocol_message", text)
                    continue
                kind = message["type"]
                if kind in ("control_request", "control_response"):
                    await self._handle_control(message, text)
                    continue
                capabilities = message.get("capabilities")
                if (kind == "system" and message.get("subtype") == "init" and
                        isinstance(capabilities, dict) and capabilities.get("result_input_id") is True):
                    expects_input_ids = True
                if kind == "result":
                    tagged = "input_id" in message
                    if (not session_failed and not tagged and message.get("error_scope") == "session"
                            and message.get("is_error") is True):
                        session_failed = True
                        self._cancel_permissions()
                        self._messages.put_nowait(message)
                        continue
                    legacy_uuid = message.get("uuid") if not tagged else None
                    if (session_failed or not self._pending_inputs or
                            ((tagged or expects_input_ids) and message.get("input_id") != self._pending_inputs[0]) or
                            (isinstance(legacy_uuid, str) and legacy_uuid in legacy_result_uuids)):
                        self._diagnostic("invalid_protocol_message", "Unexpected result: " + text)
                        continue
                    if tagged:
                        expects_input_ids = True
                    if isinstance(legacy_uuid, str) and legacy_uuid:
                        legacy_result_uuids.add(legacy_uuid)
                    self._pending_inputs.popleft()
                    self._results += 1
                    self._cancel_permissions()
                    self._maybe_close_input()
                self._messages.put_nowait(message)
            code = await self._process.wait()
            await self._stderr_task
            errors = self._stderr.decode("utf-8", "replace")
            if code != 0:
                if self._results == 0 and not session_failed:
                    raise RuntimeError("CCR exited {}: {}".format(code, errors))
                self._diagnostic("abnormal_exit", "CCR exited {} after the result frame: {}".format(code, errors[-500:]))
            if not session_failed and self._results < self._sent:
                raise RuntimeError("CLI closed before all query results ({}/{})".format(self._results, self._sent))
        except asyncio.CancelledError:
            if not self._closing:
                self._failure = RuntimeError("CLI reader cancelled")
            raise
        except Exception as error:
            if not self._closing:
                self._failure = error
        finally:
            self._reader_done = True
            self._cancel_permissions()
            self._reject_pending()
            self._messages.put_nowait(_END)

    async def _terminate_owned_process(self) -> None:
        process = self._process
        if process.returncode is not None:
            return
        try:
            if os.name == "nt":
                binary = Path(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
                killer = await asyncio.create_subprocess_exec(
                    str(binary), "/PID", str(process.pid), "/T", "/F",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    creationflags=0x08000000)
                try:
                    output, diagnostic = await asyncio.wait_for(killer.communicate(), timeout=5)
                except asyncio.TimeoutError:
                    killer.kill()
                    await killer.wait()
                    raise
                if killer.returncode:
                    targets = []
                    for line in (output + b"\n" + diagnostic).splitlines():
                        match = re.search(rb"\bPID\s+(\d+)", line, re.IGNORECASE)
                        if match:
                            targets.append(int(match.group(1)))
                    if not targets and ('"{}"'.format(process.pid)).encode() in diagnostic:
                        targets.append(process.pid)
                    deadline = asyncio.get_running_loop().time() + 1
                    while targets and any(_pid_running(pid) for pid in targets) and asyncio.get_running_loop().time() < deadline:
                        await asyncio.sleep(.02)
                    if not targets or any(_pid_running(pid) for pid in targets):
                        raise RuntimeError(diagnostic.decode("utf-8", errors="replace")[-500:])
            else:
                listing = await asyncio.create_subprocess_exec(
                    "/bin/ps", "-eo", "pid=,ppid=", stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE)
                try:
                    output, _ = await asyncio.wait_for(listing.communicate(), timeout=5)
                except asyncio.TimeoutError:
                    listing.kill()
                    await listing.wait()
                    raise
                if listing.returncode:
                    raise RuntimeError("Cannot enumerate the owned CLI process tree")
                rows = [tuple(map(int, line.split())) for line in output.decode().splitlines()]
                owned, order = {process.pid}, [process.pid]
                for parent in order:
                    for pid, ppid in rows:
                        if ppid == parent and pid > 0 and pid != os.getpid() and pid not in owned:
                            owned.add(pid)
                            order.append(pid)
                for pid in reversed(order):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        except Exception as error:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            raise RuntimeError("Failed to terminate the owned CLI process tree") from error

    async def disconnect(self) -> None:
        """Cancel owned work and wait for the owned CLI process to exit."""
        if self._closed:
            return
        self._closing = True
        self._cancel_permissions()
        self._reject_pending()
        try:
            if self._process is not None and self._process.returncode is None:
                # EOF drains the CLI's queued turns. A hard disconnect with
                # outstanding results must stop work instead of allowing it.
                pending_results = self._results < self._sent
                if pending_results:
                    try:
                        self._process.stdin.write((json.dumps({"type": "control_request",
                            "request_id": "python-shutdown", "request": {"subtype": "shutdown"}}) + "\n").encode())
                        await self._process.stdin.drain()
                    except (ConnectionError, OSError):
                        pass
                    try:
                        await asyncio.wait_for(self._process.wait(), timeout=.25)
                    except asyncio.TimeoutError:
                        await self._terminate_owned_process()
                else:
                    self._process.stdin.close()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=1)
                except asyncio.TimeoutError:
                    if pending_results:
                        self._process.kill()
                        await asyncio.wait_for(self._process.wait(), timeout=1)
                    else:
                        await self._terminate_owned_process()
                        try:
                            await asyncio.wait_for(self._process.wait(), timeout=1)
                        except asyncio.TimeoutError:
                            self._process.kill()
                            await asyncio.wait_for(self._process.wait(), timeout=1)
        finally:
            tasks = [task for task in (self._reader_task, self._stderr_task) if task is not None]
            tasks.extend(self._permissions.values())
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.wait(tasks, timeout=3)
            self._closed = True
            if not self._reader_done:
                self._messages.put_nowait(_END)


async def query(prompt: str, *, cwd: Optional[str] = None,
                env: Optional[Dict[str, str]] = None, model: Optional[str] = None,
                max_turns: int = 8, resume: Optional[str] = None,
                can_use_tool: Optional[CanUseTool] = None,
                cli: Optional[str] = None) -> AsyncIterator[Dict[str, Any]]:
    """One-shot query. Consume the stream to include post-result exit diagnostics."""
    async with CCRClient(cwd=cwd, env=env, model=model, max_turns=max_turns,
                         resume=resume, can_use_tool=can_use_tool, cli=cli) as client:
        await client.query(prompt)
        await client.finish()
        async for message in client.receive_messages():
            yield message
