import { summarizeConversationRange } from "../auto-compact.js";
import {
  forkCheckpoints,
  listTurns,
  previewRestore,
  resetCheckpoints,
  restoreToTurn,
  turnOfMessage,
} from "../checkpoint.js";
import type { CommandContext } from "../commands/types.js";
import { resetSystemPromptCache } from "../system-prompt.js";
import type { Message, ModelCaller, ModelConfig } from "../types.js";
import { isSyntheticUserMessage, messagesToTranscript } from "./history-replay.js";
import type { RewindChoice, RewindEntry, TuiStore } from "./store.js";

function messageText(message: Message): string {
  if (message.role !== "user") return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function rewindEntries(messages: Message[], sessionId: string): RewindEntry[] {
  const turns = listTurns(sessionId);
  return messages
    .filter((message) => message.role === "user" && !isSyntheticUserMessage(message))
    .map((message, index) => {
      const turn = turnOfMessage(message, sessionId);
      const preview =
        turn === null ? { files: [], available: false } : previewRestore(sessionId, turn);
      const timestampMs = turns.find((entry) => entry.turn === turn)?.timestamp;
      return {
        turnIndex: index + 1,
        label: messageText(message).replace(/\s+/g, " ") || "(empty)",
        timestamp: "",
        timestampMs,
        filesChanged: preview.files.length,
        canRestoreCode: preview.available && preview.files.length > 0,
        checkpointAvailable: preview.available,
      };
    });
}

/** Execute the selected operation before replacing any visible or model history. */
export async function applyRewindChoice(
  store: TuiStore,
  deps: {
    messages: Message[];
    sessionId: string;
    context: CommandContext;
    callModel: ModelCaller;
    modelConfig: ModelConfig;
    signal?: AbortSignal;
  },
  choice: RewindChoice,
): Promise<void> {
  const { messages, sessionId, context } = deps;
  const userIndices = messages.flatMap((message, index) =>
    message.role === "user" && !isSyntheticUserMessage(message) ? [index] : [],
  );
  const cutAt = userIndices[choice.turnIndex - 1];
  if (cutAt === undefined)
    throw new Error("The selected message is no longer in this conversation.");
  const selected = messages[cutAt];
  if (!selected) throw new Error("The selected message is no longer in this conversation.");
  const turn = turnOfMessage(selected, sessionId);
  const { action } = choice;
  let next: Message[];

  if (action === "summarize" || action === "summarize_up_to") {
    const range = action === "summarize" ? messages.slice(cutAt) : messages.slice(0, cutAt);
    const summary = await summarizeConversationRange(
      range,
      deps.callModel,
      deps.modelConfig,
      choice.context,
      deps.signal,
    );
    if (deps.signal?.aborted) throw new Error("Summarization cancelled.");
    const summaryMessage: Message = {
      role: "system",
      content: `[Conversation summary]\n${summary}`,
    };
    next =
      action === "summarize"
        ? [...messages.slice(0, cutAt), summaryMessage]
        : [summaryMessage, ...messages.slice(cutAt)];
    await context.persistence?.save(sessionId, next);
    messages.splice(0, messages.length, ...next);
    store.resetTranscript();
    store.loadTranscript(messagesToTranscript(next));
    store.addCompactSummary(summary, range.length);
    if (action === "summarize")
      store.setDraft({ text: messageText(selected), cursor: messageText(selected).length });
  } else if (action === "code") {
    if (turn === null || !previewRestore(sessionId, turn).available)
      throw new Error("No file checkpoint is available for this message.");
    const result = restoreToTurn(sessionId, turn);
    if (result.failures?.length)
      throw new Error(
        result.failures.map((failure) => `${failure.path}: ${failure.error}`).join("; "),
      );
    store.addNotice(
      `Code restored: ${result.restored.length} files rewritten, ${result.deleted.length} deleted. Conversation kept.`,
    );
    return;
  } else {
    if (!context.persistence || !context.resumeSession)
      throw new Error("Session persistence is required to fork this conversation.");
    if (action === "both" && (turn === null || !previewRestore(sessionId, turn).available))
      throw new Error("No file checkpoint is available for this message.");
    // Save the original before creating and activating the restored conversation.
    await context.persistence.save(sessionId, messages);
    const newId = context.persistence.generateId();
    next = messages.slice(0, cutAt).map((message) => {
      const checkpointTurn = turnOfMessage(message, sessionId);
      return message.role === "user" && checkpointTurn !== null
        ? { ...message, checkpoint: { sessionId: newId, turn: checkpointTurn } }
        : message;
    });
    forkCheckpoints(sessionId, newId);
    try {
      if (action === "both") {
        if (turn === null || !previewRestore(newId, turn).available)
          throw new Error("No file checkpoint is available for this message.");
        const result = restoreToTurn(newId, turn);
        if (result.failures?.length)
          throw new Error(
            result.failures.map((failure) => `${failure.path}: ${failure.error}`).join("; "),
          );
      }
      await context.persistence.save(newId, next);
      if (!(await context.resumeSession(newId)))
        throw new Error(
          "Could not activate the restored session; the original conversation is preserved.",
        );
    } catch (error) {
      resetCheckpoints(newId);
      await context.persistence.deleteSession?.(newId).catch(() => {});
      throw error;
    }
    store.resetTranscript();
    store.loadTranscript(messagesToTranscript(messages));
    store.setTodos([]);
    const text = messageText(selected);
    store.setDraft({ text, cursor: text.length });
  }
  resetSystemPromptCache();
}
