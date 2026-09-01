import crypto from 'node:crypto';
import { CanonicalEvent } from '../normalize/canonical-event.js';
import { SessionDigest } from '../normalize/session-digest.js';

export type TraitCategory =
  | 'preferences'
  | 'decision_style'
  | 'collaboration_style'
  | 'values_principles'
  | 'current_goals';

export type SignalType =
  | 'explicit_statement'
  | 'behavior'
  | 'choice'
  | 'correction'
  | 'contradiction';

export interface EvidenceCandidate {
  id: string;
  category: TraitCategory;
  candidate: string;
  statement: string;
  scope: string; // 'global' | 'reversible-actions' | 'destructive-actions'
  canonical_key: string; // for deterministic semantic grouping
  signal_type: SignalType;
  strength: number;
  timestamp: string;
  source: {
    framework: string;
    session_id: string;
    event_ids: string[];
  };
  context: {
    project: string | null;
    task_type?: string;
    cwd?: string;
  };
}

export interface DroppedTaskSignal {
  session_id: string;
  content: string;
  reason: string;
}

// Global registry of dropped task-level items for audit/reporting
export const globalDroppedTaskSignals: DroppedTaskSignal[] = [];

// Sensitive keywords to filter out (Section 17: Privacy & Boundary)
const SENSITIVE_PATTERNS = [
  /\b(password|secret|token|apikey|api_key|credential|private_key)\b/i,
  /\b(health|medical|illness|disease|doctor|patient|prescription)\b/i,
  /\b(religion|church|mosque|temple|prayer|faith|god)\b/i,
  /\b(politics|election|political|party|president|vote)\b/i,
  /\b(sexual|sexuality|orientation|lgbt)\b/i,
  /(密码|口令|秘钥|私钥|敏感信息|政治|宗教|疾病|就医|处方|病历)/
];

function isSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(text));
}

// Patterns that identify quoted external content or system-injected instructions
const QUOTED_OR_INJECTED_PATTERNS = [
  /<claude-mem-context>[\s\S]*?<\/claude-mem-context>/gi,
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,
  /<agentmemory-context[\s\S]*?<\/agentmemory-context>/gi,
  /<hcom_system_context>[\s\S]*?<\/hcom_system_context>/gi,
  /#\s*(?:Memory Context|\$CMEM|AGENTS\.md instructions)/i,
  /```[\s\S]*?```/g,
  /\b(?:Traceback \(most recent call last\)|Failed with result 'exit-code'|systemd\[\d+\]:)\b/i
];

function sanitizeUserText(text: string): string {
  let cleaned = text;
  for (const p of QUOTED_OR_INJECTED_PATTERNS) {
    cleaned = cleaned.replace(p, '');
  }
  return cleaned.trim();
}

// Task-level correction patterns that must be rejected from USER MODEL
const TASK_LEVEL_CORRECTION_PATTERNS = [
  // Port / IP / Host / Path changes
  /(?:端口|port)\s*(?:改成|设为|变为|改为|change to|=)\s*\d+/i,
  /(?:路径|path|目录|dir)\s*(?:改成|设为|改为|放到)/i,
  
  // Transient UI / styling tweaks
  /(?:按钮|颜色|背景|边框|字体|间距|padding|margin|color|button|font|border)\s*(?:不要用|改成|设为|改为|变更为)/i,
  /(?:居中|加宽|缩小|放大|高亮|隐藏|显示|对齐)/,

  // One-off runtime / tool / systemd debug fixes
  /(?:不要用系统级|不要用systemd|改用nohup|改用pm2|用docker启动)/i,
  /(?:看(?:一下|下)?日志|查一下报错|服务挂了|重启一下|排查一下)/,
  
  // Transient task feedback / debug prompts
  /^(?:不对|错了|不是这样|改一下|这里有bug|这里报错了|编译失败|测试没过|重新跑|再试一次|继续|那你修一下|修一下|帮我修下)$/i,
  /^(?:把这里的?|将这里的?)(?:if|函数|变量|代码|逻辑|配置|参数)(?:改一下|修改为|改成|删掉)/i,
];

function isTaskLevelCorrection(text: string): { isTask: boolean; reason?: string } {
  for (const p of TASK_LEVEL_CORRECTION_PATTERNS) {
    if (p.test(text)) {
      return { isTask: true, reason: `Matches task-level pattern: ${p.source}` };
    }
  }
  return { isTask: false };
}

// Trivial command / routine question patterns that contain 0 user signals
const TRIVIAL_PATTERNS = [
  /^(ls|pwd|cd|cat|git status|git diff|date|which|whoami|echo|ps|top|node -v|npm -v)/i,
  /^(hi|hello|hey|你好|在吗|在么)$/i,
  /^(ok|yes|好的|收到|行|可以|嗯|好|done|thanks|谢谢)$/i,
  /^(帮我看看|看一下|查一下|查看|读取)[\s\S]{0,20}(状态|日志|文件|报错|端口|内容|代码)/i,
];

export function triageSession(digest: SessionDigest): boolean {
  if (digest.user_turns.length === 0) return false;

  // If user has feedback (durable preference keywords), pass triage
  if (digest.has_user_feedback) return true;

  // Check if all user turns are trivial
  const nonTrivialTurns = digest.user_turns.filter(ut => {
    const text = sanitizeUserText(ut.content);
    if (text.length < 5) return false;
    if (TRIVIAL_PATTERNS.some(p => p.test(text))) return false;
    if (isTaskLevelCorrection(text).isTask) return false;
    return true;
  });

  return nonTrivialTurns.length > 0;
}

export function extractCandidatesFromSession(
  adapterName: string,
  events: CanonicalEvent[],
  digest: SessionDigest
): EvidenceCandidate[] {
  // Stage A: Triage
  if (!triageSession(digest)) {
    return [];
  }

  const candidates: EvidenceCandidate[] = [];

  // Section 8: ANTI-SELF-REINFORCEMENT
  // ONLY process events where role === 'user'. Strictly ignore 'assistant', 'system', 'tool'.
  const userEvents = events.filter(e => e.role === 'user');

  for (const ev of userEvents) {
    const rawContent = ev.content.trim();
    if (!rawContent || isSensitive(rawContent)) continue;

    const content = sanitizeUserText(rawContent);
    if (!content || content.length < 4) continue;

    // Check if this is a task-level correction
    const taskCheck = isTaskLevelCorrection(content);
    if (taskCheck.isTask) {
      globalDroppedTaskSignals.push({
        session_id: ev.session_id,
        content: content.slice(0, 100),
        reason: taskCheck.reason || 'Task-level feedback'
      });
      continue;
    }

    // Check for explicit durable statements / principles / collaboration rules
    const extracted = extractSignalsFromUserText(content, ev, adapterName);
    candidates.push(...extracted);
  }

  return candidates;
}

function extractSignalsFromUserText(
  text: string,
  event: CanonicalEvent,
  adapterName: string
): EvidenceCandidate[] {
  const results: EvidenceCandidate[] = [];
  const lower = text.toLowerCase();

  const makeId = (cat: string, canonicalKey: string) => {
    const hash = crypto.createHash('md5').update(`${event.session_id}-${event.event_id}-${cat}-${canonicalKey}`).digest('hex').slice(0, 12);
    return `ev_${hash}`;
  };

  // ==========================================
  // 1. Preferences
  // ==========================================

  // 1.1 Output concise / direct diff preference
  if (
    lower.includes('不想要冗长') ||
    lower.includes('不要冗长') ||
    lower.includes('直接给出diff') ||
    lower.includes('直接给diff') ||
    lower.includes('简短') ||
    lower.includes('直接给代码') ||
    lower.includes('concise output') ||
    lower.includes('no long explanation') ||
    lower.includes('direct diff')
  ) {
    results.push({
      id: makeId('preferences', 'concise_diff_output'),
      category: 'preferences',
      candidate: 'prefers concise output and direct diffs rather than verbose explanations',
      statement: 'Prefers concise, direct output and code diffs rather than lengthy explanations.',
      scope: 'global',
      canonical_key: 'concise_diff_output',
      signal_type: 'explicit_statement',
      strength: 0.9,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 1.2 Tooling: pnpm package manager preference (durable preference statement)
  if (
    (text.includes('用 pnpm') || text.includes('习惯用 pnpm') || text.includes('以后都用 pnpm') || text.includes('项目统一用 pnpm') || text.includes('always use pnpm') || text.includes('prefer pnpm')) &&
    !text.includes('按钮') && !text.includes('端口')
  ) {
    results.push({
      id: makeId('preferences', 'use_pnpm'),
      category: 'preferences',
      candidate: 'prefers pnpm as package manager for js/ts projects',
      statement: 'Prefers pnpm as the package manager for JavaScript/TypeScript projects.',
      scope: 'global',
      canonical_key: 'use_pnpm',
      signal_type: 'explicit_statement',
      strength: 0.85,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 1.3 Strict TypeScript preference
  if (
    (text.includes('使用 typescript') || text.includes('写 typescript') || text.includes('prefer strict typescript') || text.includes('strict typescript')) &&
    (text.includes('习惯') || text.includes('优先') || text.includes('规范') || text.includes('always') || text.includes('prefer'))
  ) {
    results.push({
      id: makeId('preferences', 'use_strict_typescript'),
      category: 'preferences',
      candidate: 'prefers strict TypeScript for implementations',
      statement: 'Prefers strict TypeScript for implementations.',
      scope: 'global',
      canonical_key: 'use_strict_typescript',
      signal_type: 'explicit_statement',
      strength: 0.85,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // ==========================================
  // 2. Decision Style
  // ==========================================

  // 2.1 Empirical validation over assumptions
  if (
    lower.includes('先验证') ||
    lower.includes('测试验证') ||
    lower.includes('跑测试验证') ||
    lower.includes('以运行结果为准') ||
    lower.includes('拿结果说话') ||
    lower.includes('拿证据说话') ||
    lower.includes('不要假设') ||
    lower.includes('empirical validation') ||
    lower.includes('verify with tests') ||
    lower.includes('evidence over assumption')
  ) {
    results.push({
      id: makeId('decision_style', 'empirical_validation'),
      category: 'decision_style',
      candidate: 'favors empirical runtime validation and test evidence over design assumptions',
      statement: 'Favors empirical runtime validation and test evidence over unverified design assumptions.',
      scope: 'global',
      canonical_key: 'empirical_validation',
      signal_type: 'explicit_statement',
      strength: 0.9,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 2.2 Reversible experimentation
  if (
    lower.includes('小步快跑') ||
    lower.includes('可逆实验') ||
    lower.includes('先做最小可行') ||
    lower.includes('low-cost reversible experiments') ||
    lower.includes('cheap experiment')
  ) {
    results.push({
      id: makeId('decision_style', 'reversible_experimentation'),
      category: 'decision_style',
      candidate: 'prefers small reversible experiments when uncertainty can be resolved cheaply',
      statement: 'Prefers small, reversible experiments when uncertainty can be resolved cheaply.',
      scope: 'global',
      canonical_key: 'reversible_experimentation',
      signal_type: 'explicit_statement',
      strength: 0.85,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // ==========================================
  // 3. Collaboration Style
  // ==========================================

  // 3.1 Autonomous action on reversible engineering tasks
  if (
    lower.includes('自主推进') ||
    lower.includes('不用每次确认') ||
    lower.includes('不要每次问我') ||
    lower.includes('可逆任务不要每次问') ||
    lower.includes('可逆任务直接做') ||
    lower.includes('act autonomously') ||
    lower.includes('proceed without asking on reversible') ||
    lower.includes('no need to confirm low-risk')
  ) {
    results.push({
      id: makeId('collaboration_style', 'autonomous_reversible_work'),
      category: 'collaboration_style',
      candidate: 'prefers autonomous progress on reversible local engineering work without redundant confirmation',
      statement: 'For reversible local engineering work, prefers autonomous progress without redundant confirmation.',
      scope: 'reversible-actions',
      canonical_key: 'autonomous_reversible_work',
      signal_type: 'explicit_statement',
      strength: 0.95,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 3.2 Require confirmation for destructive / high-risk operations
  if (
    lower.includes('破坏性操作先确认') ||
    lower.includes('删库前确认') ||
    lower.includes('重大变更先问我') ||
    lower.includes('高危操作先确认') ||
    lower.includes('confirm before delete') ||
    lower.includes('confirm irreversible') ||
    lower.includes('ask before dangerous')
  ) {
    results.push({
      id: makeId('collaboration_style', 'confirm_destructive_actions'),
      category: 'collaboration_style',
      candidate: 'expects explicit confirmation before irreversible or destructive actions',
      statement: 'For irreversible, destructive, or externally consequential actions, expects explicit confirmation.',
      scope: 'destructive-actions',
      canonical_key: 'confirm_destructive_actions',
      signal_type: 'explicit_statement',
      strength: 0.95,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 3.3 Explicit verification requirement on completion claims
  if (
    lower.includes('要有验证证据') ||
    lower.includes('要有测试证据') ||
    lower.includes('完成前提供测试证明') ||
    lower.includes('prove completion with tests') ||
    lower.includes('completion claims must have runtime evidence')
  ) {
    results.push({
      id: makeId('collaboration_style', 'completion_runtime_evidence'),
      category: 'collaboration_style',
      candidate: 'expects task completion claims to be accompanied by concrete runtime verification evidence',
      statement: 'Expects task completion claims to be accompanied by concrete runtime verification evidence.',
      scope: 'global',
      canonical_key: 'completion_runtime_evidence',
      signal_type: 'explicit_statement',
      strength: 0.9,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // ==========================================
  // 4. Values / Principles
  // ==========================================

  // 4.1 Thin runtime
  if (
    lower.includes('保持 runtime 薄') ||
    lower.includes('不要把复杂度塞进 runtime') ||
    lower.includes('薄 runtime') ||
    lower.includes('thin runtime') ||
    lower.includes('keep runtime thin') ||
    lower.includes('minimal core loop')
  ) {
    results.push({
      id: makeId('values_principles', 'thin_runtime_architecture'),
      category: 'values_principles',
      candidate: 'believes in keeping agent runtime thin, lightweight, and decoupled',
      statement: 'Believes in keeping the agent runtime thin, lightweight, and decoupled from heavy offline processes.',
      scope: 'global',
      canonical_key: 'thin_runtime_architecture',
      signal_type: 'explicit_statement',
      strength: 0.95,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // 4.2 Delete unused complexity
  if (
    lower.includes('没有收益就删掉复杂度') ||
    lower.includes('实验没收益就删掉') ||
    lower.includes('不因为是我提的就保留') ||
    lower.includes('删掉复杂度') ||
    lower.includes('不为未验证的想法保留复杂度') ||
    lower.includes('remove unused complexity') ||
    lower.includes('delete complexity if no value')
  ) {
    results.push({
      id: makeId('values_principles', 'prune_unused_complexity'),
      category: 'values_principles',
      candidate: 'insists on pruning unnecessary complexity when an abstraction does not show demonstrable utility',
      statement: 'Insists on pruning unnecessary complexity when an abstraction does not show demonstrable utility.',
      scope: 'global',
      canonical_key: 'prune_unused_complexity',
      signal_type: 'explicit_statement',
      strength: 0.95,
      timestamp: event.timestamp,
      source: {
        framework: adapterName,
        session_id: event.session_id,
        event_ids: [event.event_id]
      },
      context: {
        project: event.project,
        cwd: event.metadata?.cwd
      }
    });
  }

  // ==========================================
  // 5. Current Goals / Active Priorities
  // ==========================================
  if (
    (lower.includes('当前重点是') || lower.includes('最近在做') || lower.includes('优先级最高的是') || lower.includes('current focus is')) &&
    !lower.includes('端口') && !lower.includes('按钮')
  ) {
    const goalMatch = text.match(/(?:当前重点是|最近在做|优先级最高的是|current focus is)[:：\s]*(.+)/i);
    if (goalMatch && goalMatch[1].trim().length > 3) {
      const goalContent = goalMatch[1].slice(0, 80).trim();
      results.push({
        id: makeId('current_goals', 'active_priority'),
        category: 'current_goals',
        candidate: `active priority: ${goalContent}`,
        statement: `Active priority / focus: ${goalContent}`,
        scope: 'global',
        canonical_key: 'active_priority',
        signal_type: 'explicit_statement',
        strength: 0.8,
        timestamp: event.timestamp,
        source: {
          framework: adapterName,
          session_id: event.session_id,
          event_ids: [event.event_id]
        },
        context: {
          project: event.project,
          cwd: event.metadata?.cwd
        }
      });
    }
  }

  return results;
}
