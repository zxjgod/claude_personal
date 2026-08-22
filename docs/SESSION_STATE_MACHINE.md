# Session State Machine

## Overview

Sessions track **runtime lifecycle state** through the `TaskState` type, which represents objective facts about where execution paused, not business-completion claims. This enables reliable resume behavior after interruptions, crashes, or user stops.

## State Definitions

```typescript
type TaskState =
  | "waiting_for_model"    // Waiting for LLM API response
  | "waiting_for_tool"     // Tool execution in progress
  | "recovering"           // Context compaction in progress
  | "paused"               // Natural completion (finish_reason: stop)
  | "failed"               // Error occurred (API failure, tool crash)
  | "stopped_by_user";     // User interrupted (Ctrl+C, /exit)
```

## State Transitions

```
                    ┌──────────────────────────┐
                    │   Session Start/Resume   │
                    └────────────┬─────────────┘
                                 │
                                 v
                    ┌────────────────────────┐
                    │   waiting_for_model    │◄────┐
                    └────────┬───────────────┘     │
                             │                      │
                    Model responds                  │
                             │                      │
                             v                      │
                    ┌────────────────────────┐     │
                    │   waiting_for_tool     │     │
                    └────────┬───────────────┘     │
                             │                      │
                    Tools complete                  │
                             │                      │
                             └──────────────────────┘
                             
                    Context over threshold
                             │
                             v
                    ┌────────────────────────┐
                    │     recovering         │
                    └────────┬───────────────┘
                             │
                    Compaction done
                             │
                             v
                    ┌────────────────────────┐
                    │   waiting_for_model    │
                    └────────────────────────┘

                    finish_reason: stop
                             │
                             v
                    ┌────────────────────────┐
                    │       paused           │  (resumable)
                    └────────────────────────┘

                    API error / crash
                             │
                             v
                    ┌────────────────────────┐
                    │       failed           │  (needs diagnosis)
                    └────────────────────────┘

                    User Ctrl+C / /exit
                             │
                             v
                    ┌────────────────────────┐
                    │   stopped_by_user      │  (explicit stop)
                    └────────────────────────┘
```

## State Persistence

States are persisted **on every transition** to enable crash recovery:

```typescript
// Examples from agent loop:
case "thinking":
  deps.onSave("waiting_for_model");  // Before API call

case "tool_use":
  deps.onSave("waiting_for_tool");   // Before tool exec

case "compacting":
  deps.onSave("recovering");         // During compaction

case "terminal":
  deps.onSave("paused", normalizeFinishReason(event.finishReason));

case "error":
  deps.onSave("failed");

case "aborted":
  deps.onSave("stopped_by_user", "aborted_by_user");
```

## Resume Behavior

| State              | Resume Strategy                                      |
|--------------------|------------------------------------------------------|
| `paused`           | Direct resume — continue conversation                |
| `waiting_for_model`| Retry API call (may have timed out mid-request)      |
| `waiting_for_tool` | Check tool status, retry or skip if stuck            |
| `recovering`       | Re-run compaction (was interrupted mid-process)      |
| `failed`           | Show error, ask user to diagnose before resuming     |
| `stopped_by_user`  | Clear state, treat as fresh start                    |

## lastTerminalReason

The `lastTerminalReason` field stores the normalized `finish_reason` from the LLM API when the session reaches a terminal state. This provides additional context for why execution stopped.

### Normalization

Different providers return different values for the same concept. We normalize to standard values:

```typescript
function normalizeFinishReason(raw: string | undefined): string | undefined {
  // "stop", "end_turn", "completed" → "stop"
  // "length", "max_tokens" → "length"
  // "tool_calls", "tool_use" → "tool_calls"
  // "content_filter", "safety" → "content_filter"
}
```

### Common Values

- `"stop"` — Natural completion, model decided to stop
- `"length"` — Token limit reached
- `"tool_calls"` — Stopped to invoke tools (not actually terminal)
- `"aborted_by_user"` — User interrupted with Ctrl+C

## Design Principles

1. **States are facts, not opinions** — They describe what happened technically, not whether the user's task is complete.

2. **`paused` ≠ "done"** — A paused session just means the model stopped talking. The user may want to continue.

3. **Crash-safe by design** — Every state transition persists immediately. Killing the process at any point leaves a resumable state.

4. **No silent truncation** — If a session is in `failed` or `stopped_by_user`, we never auto-resume or pretend nothing happened.

5. **Idempotent resume** — Resuming from the same state multiple times produces the same behavior (e.g., retrying a failed API call is safe).

## Catalog Format

The `catalog.json` file stores metadata for faster session listing:

```json
{
  "session-id-1": {
    "pinned": true,
    "preview": "First user message text..."
  },
  "session-id-2": {
    "preview": "Another session preview"
  }
}
```

- **pinned**: Boolean flag for user-pinned sessions (shown first in lists)
- **preview**: Cached first user message (avoid loading full session for search)

### Concurrency Protection

File lock (via `proper-lockfile`) prevents concurrent writes from corrupting the catalog. Lock parameters:
- Retries: 5 attempts, 50-200ms backoff
- Stale timeout: 10 seconds (assumes dead process if lock held longer)

## Migration History

- **v1**: Initial format (sessionId, createdAt, updatedAt, messages)
- **v2**: Added workspaceRoot, messageCount, completed fields
- **v3**: Added taskState and lastTerminalReason (this design)

Migrations validate input data and throw on corruption to prevent silently accepting broken sessions.
