// ============================================================
// Persistence — Save and restore conversation sessions
// ============================================================
// Backward-compatible thin wrapper over SessionMemory (M19.4).
//
// The actual session message+metadata read/write logic now lives in
// src/session-memory.ts. PersistenceManager remains here as a subclass so
// every existing import (`from "./persistence.js"`) and the persistence test
// suite keep working unchanged. New code may import SessionMemory directly.
// ============================================================

import { SessionMemory } from "./session-memory.js";

export type { SessionData, SessionMeta } from "./session-memory.js";

/**
 * Backward-compatible alias for SessionMemory. Stores conversation history as
 * JSON files under <workspace>/.claude/sessions/<sessionId>.json.
 */
export class PersistenceManager extends SessionMemory {}
