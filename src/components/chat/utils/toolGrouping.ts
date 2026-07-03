import type { ChatMessage } from '../types/types';

export const TOOL_GROUP_THRESHOLD = 2;

export interface ToolGroupItem {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(message.isToolUse && message.toolName && !message.isSubagentContainer);
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of the same tool — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

export type ToolCallDisplayMode = 'show' | 'collapsed' | 'hidden';

/** True for any message that represents tool activity in the transcript. */
function isToolActivityMessage(message: ChatMessage): boolean {
  return Boolean(message.isToolUse || message.type === 'tool');
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
  toolCallDisplay: ToolCallDisplayMode = 'show',
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  // In collapsed mode every tool call renders as a one-line expandable group
  // row, so even a single call is wrapped instead of shown in full.
  const groupThreshold = toolCallDisplay === 'collapsed' ? 1 : TOOL_GROUP_THRESHOLD;

  while (index < messages.length) {
    const message = messages[index];

    if (toolCallDisplay === 'hidden' && isToolActivityMessage(message)) {
      index += 1;
      continue;
    }

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate) && candidate.toolName === message.toolName) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= groupThreshold) {
      items.push({
        _isGroup: true,
        toolName: message.toolName,
        messages: run,
        timestamp: message.timestamp,
      });
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
