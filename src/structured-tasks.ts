// ============================================================
// Structured Task Management System
// ============================================================
// Manages structured task tracking with status, dependencies, and metadata.
// Separate from the "task" tool which spawns sub-agents - this is for
// tracking work items in a project management style.
// ============================================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface StructuredTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  metadata?: Record<string, unknown>;
  blocks: string[]; // Task IDs that this task blocks
  blockedBy: string[]; // Task IDs that block this task
  createdAt: bigint;
  updatedAt: bigint;
}

// Session-scoped task registry
const TASK_REGISTRY = new Map<string, Map<string, StructuredTask>>();
export function restoreStructuredTasks(sessionId: string, values: unknown[]): void {
  const tasks = getTaskMap(sessionId);
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<StructuredTask>;
    if (
      typeof entry.id !== "string" ||
      typeof entry.subject !== "string" ||
      !["pending", "in_progress", "completed", "deleted"].includes(String(entry.status))
    )
      continue;
    const task: StructuredTask = {
      id: entry.id,
      subject: entry.subject,
      description: entry.description ?? "",
      status: entry.status === "in_progress" ? "pending" : entry.status!,
      blocks: Array.isArray(entry.blocks)
        ? entry.blocks.filter((id) => typeof id === "string")
        : [],
      blockedBy: Array.isArray(entry.blockedBy)
        ? entry.blockedBy.filter((id) => typeof id === "string")
        : [],
      owner: entry.owner,
      metadata: entry.metadata,
      createdAt: process.hrtime.bigint(),
      updatedAt: process.hrtime.bigint(),
    };
    tasks.set(task.id, task);
    taskIdCounter = Math.max(taskIdCounter, Number(task.id) || 0);
  }
}

let taskIdCounter = 0;

/**
 * True when adding the edge blockerId→blockedId would close a dependency
 * cycle (blockedId already transitively blocks blockerId).
 */
function wouldCreateCycle(
  tasks: Map<string, StructuredTask>,
  blockerId: string,
  blockedId: string,
): boolean {
  const seen = new Set<string>();
  const stack = [blockedId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockerId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const task = tasks.get(current);
    if (task) stack.push(...task.blocks);
  }
  return false;
}

function nextTaskId(): string {
  taskIdCounter += 1;
  return `${taskIdCounter}`;
}

/**
 * Get the task map for a session, creating it if needed.
 */
function getTaskMap(sessionId: string): Map<string, StructuredTask> {
  let map = TASK_REGISTRY.get(sessionId);
  if (!map) {
    map = new Map();
    TASK_REGISTRY.set(sessionId, map);
  }
  return map;
}

/**
 * Create a new task.
 */
export function createTask(
  sessionId: string,
  subject: string,
  description: string,
  activeForm?: string,
  metadata?: Record<string, unknown>,
): StructuredTask {
  const now = process.hrtime.bigint();
  const task: StructuredTask = {
    id: nextTaskId(),
    subject,
    description,
    activeForm,
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata: metadata ? { ...metadata } : undefined,
    createdAt: now,
    updatedAt: now,
  };
  getTaskMap(sessionId).set(task.id, task);
  return task;
}

/**
 * Get a task by ID.
 */
export function getTask(sessionId: string, taskId: string): StructuredTask | undefined {
  return getTaskMap(sessionId).get(taskId);
}

/**
 * List all tasks for a session.
 */
export function listTasks(sessionId: string): StructuredTask[] {
  return Array.from(getTaskMap(sessionId).values());
}

/**
 * Update a task. Returns the updated task or undefined if not found.
 */
export function updateTask(
  sessionId: string,
  taskId: string,
  updates: {
    subject?: string;
    description?: string;
    activeForm?: string;
    status?: TaskStatus;
    owner?: string;
    metadata?: Record<string, unknown>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  },
): StructuredTask | undefined {
  const task = getTask(sessionId, taskId);
  if (!task) return undefined;

  // Review fix ("deleted 任务永不移除"): status:"deleted" used to just tag
  // the task — it stayed in the map (listed as [deleted], still holding
  // dependency edges) forever. Actually remove it and scrub both directions
  // of every edge pointing at it.
  if (updates.status === "deleted") {
    const tasks = getTaskMap(sessionId);
    tasks.delete(taskId);
    for (const other of tasks.values()) {
      other.blocks = other.blocks.filter((id) => id !== taskId);
      other.blockedBy = other.blockedBy.filter((id) => id !== taskId);
    }
    task.status = "deleted";
    task.updatedAt = process.hrtime.bigint();
    return task;
  }

  if (updates.subject !== undefined) task.subject = updates.subject;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.owner !== undefined) task.owner = updates.owner;

  // Merge metadata (set key to null to delete it)
  if (updates.metadata) {
    if (!task.metadata) task.metadata = {};
    for (const [key, value] of Object.entries(updates.metadata)) {
      if (value === null) {
        delete task.metadata[key];
      } else {
        task.metadata[key] = value;
      }
    }
  }

  // Add dependencies. Both directions of the edge are written so
  // blocks/blockedBy stay consistent; unknown targets and self-references are
  // ignored, and an edge that would create a dependency cycle is skipped.
  const tasks = getTaskMap(sessionId);
  const addEdge = (blockerId: string, blockedId: string): void => {
    if (blockerId === blockedId) return;
    const blocker = tasks.get(blockerId);
    const blocked = tasks.get(blockedId);
    if (!blocker || !blocked) return;
    if (wouldCreateCycle(tasks, blockerId, blockedId)) return;
    if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
    if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
  };
  for (const id of updates.addBlocks ?? []) addEdge(taskId, id);
  for (const id of updates.addBlockedBy ?? []) addEdge(id, taskId);

  task.updatedAt = process.hrtime.bigint();
  return task;
}

/**
 * Delete all tasks for a session (used in tests).
 */
export function clearTasks(sessionId: string): void {
  TASK_REGISTRY.delete(sessionId);
}

/**
 * Reset the task ID counter (used in tests).
 */
export function resetTaskIdCounter(): void {
  taskIdCounter = 0;
}
