import { CanonicalEvent } from './canonical-event.js';

export interface SessionDigest {
  session_id: string;
  adapter: string;
  started_at: string;
  ended_at: string;
  project: string | null;
  user_turn_count: number;
  assistant_turn_count: number;
  tool_call_count: number;
  user_turns: CanonicalEvent[];
  has_user_feedback: boolean;
  raw_event_count: number;
}

// Durable intent keywords that indicate user-model signals (rather than transient task feedback)
const DURABLE_FEEDBACK_PATTERNS = [
  /(?:以后|后续|长期|总是|一直|习惯|原则|规范|风格)/,
  /(?:不要每次问|不用确认|直接做|自主推进|直接修改|不要打断)/,
  /(?:破坏性|删库|重大变更|高危|外部发布).*(?:先确认|问我|审批)/,
  /(?:以测试为准|跑测试验证|拿结果说话|拿证据说话|运行验证|先验证)/,
  /(?:保持.*(?:薄|简洁|轻量)|删掉复杂度|没有收益.*删|不为未验证.*保留)/,
  /(?:不想要冗长|不要冗长|直接给(?:出)?diff|直接给代码|简短点)/,
  /\b(?:always|never|prefer|habit|principle|autonomously|without asking|thin runtime|delete complexity)\b/i
];

export function buildSessionDigest(
  sessionId: string,
  adapter: string,
  events: CanonicalEvent[]
): SessionDigest {
  const sorted = [...events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const userTurns: CanonicalEvent[] = [];
  let assistantCount = 0;
  let toolCount = 0;
  let project: string | null = null;

  for (const ev of sorted) {
    if (!project && ev.project) {
      project = ev.project;
    }
    if (ev.role === 'user') {
      userTurns.push(ev);
    } else if (ev.role === 'assistant') {
      assistantCount++;
    } else if (ev.role === 'tool') {
      toolCount++;
    }
  }

  const startedAt = sorted.length > 0 ? sorted[0].timestamp : new Date().toISOString();
  const endedAt = sorted.length > 0 ? sorted[sorted.length - 1].timestamp : startedAt;

  // Check if any user turn contains durable user-model patterns
  const hasDurableSignals = userTurns.some(ut => {
    const text = ut.content;
    return DURABLE_FEEDBACK_PATTERNS.some(p => p.test(text));
  });

  return {
    session_id: sessionId,
    adapter,
    started_at: startedAt,
    ended_at: endedAt,
    project,
    user_turn_count: userTurns.length,
    assistant_turn_count: assistantCount,
    tool_call_count: toolCount,
    user_turns: userTurns,
    has_user_feedback: hasDurableSignals,
    raw_event_count: sorted.length
  };
}
