import crypto from 'node:crypto';
import { SemanticProvider, TraitMatchDecision } from './interface.js';
import { CanonicalEvent } from '../normalize/canonical-event.js';
import { SessionDigest } from '../normalize/session-digest.js';
import { EvidenceCandidate, TraitCategory } from '../evidence/extract.js';
import { Trait } from '../traits/schema.js';
import { EvidenceEventRow } from '../storage/sqlite.js';

export interface OpenAICompatibleConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements SemanticProvider {
  readonly name: string;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private timeoutMs: number;

  constructor(config?: OpenAICompatibleConfig) {
    this.name = config?.model ? `llm-${config.model}` : 'llm-openai-compatible';
    this.endpoint = (config?.endpoint || process.env.OPENAI_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/+$/, '');
    this.apiKey = config?.apiKey || process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || '';
    this.model = config?.model || process.env.USER_MODEL_LLM || 'MiniMax-M3';
    this.temperature = config?.temperature ?? 0.1;
    this.timeoutMs = config?.timeoutMs ?? 30000;
  }

  public async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.length > 5);
  }

  public async extractEvidence(
    digest: SessionDigest,
    events: CanonicalEvent[]
  ): Promise<EvidenceCandidate[]> {
    if (!await this.isAvailable()) {
      return [];
    }

    const userEvents = events.filter(e => e.role === 'user');
    if (userEvents.length === 0) return [];

    const userTurnsText = userEvents
      .map((e, idx) => `[Turn ${idx + 1} (${e.timestamp}) Project: ${e.project || 'unknown'}]: ${e.content}`)
      .join('\n\n');

    const prompt = `You are an expert User Model Analyzer. Your job is to extract only DURABLE, cross-session user preferences, decision styles, collaboration styles, recurring principles, or automation boundaries from the following user messages.

CRITICAL RULES:
1. Strictly IGNORE transient task-level instructions (e.g. "change port to 9800", "don't use pure red for button", "fix this error", "restart the service").
2. Strictly IGNORE one-off code/config changes, bug-fix requests, and messages that merely say an implementation is wrong.
3. Extract ONLY when the user reveals a long-term preference, working principle, decision rule, or automation boundary.
4. Describe, do not prescribe: every statement must describe a user tendency or context (for example, "Prefers..." or "Tends to..."). Never output an imperative, "Agent must/should", "Always", or "Never" rule.
5. Historical patterns are revisable priors, not universal constraints; do not imply that they override current user instructions or context.
6. Output MUST be valid JSON with this exact schema:
{
  "candidates": [
    {
      "category": "preferences" | "decision_style" | "collaboration_style" | "values_principles" | "current_goals",
      "statement": "high-level generalized statement in English (e.g. 'Prefers concise diffs over verbose explanations')",
      "scope": "global" | "reversible-actions" | "destructive-actions",
      "canonical_key": "snake_case_stable_key",
      "signal_type": "explicit_statement" | "behavior" | "choice" | "correction" | "contradiction",
      "strength": 0.8-1.0,
      "reasoning": "brief explanation"
    }
  ]
}
If no durable user traits are present, return {"candidates": []}.

User Messages:
${userTurnsText}`;

    try {
      const response = await this.chatCompletion([
        { role: 'system', content: 'You extract revisable user tendencies and context, not agent rules. Describe, do not prescribe. Output strict JSON only.' },
        { role: 'user', content: prompt }
      ]);

      const json = this.parseJsonFromResponse(response);
      if (!json || !Array.isArray(json.candidates)) {
        return [];
      }

      const results: EvidenceCandidate[] = [];
      for (const item of json.candidates) {
        if (!item.statement || !item.category || !item.canonical_key) continue;

        const validCategory = this.validateCategory(item.category);
        if (!validCategory) continue;

        const primaryEvent = userEvents[0];
        const hash = crypto.createHash('md5').update(`${digest.session_id}-${item.canonical_key}-${item.statement}`).digest('hex').slice(0, 12);

        results.push({
          id: `ev_${hash}`,
          category: validCategory,
          candidate: item.statement.toLowerCase(),
          statement: item.statement.trim(),
          scope: item.scope || 'global',
          canonical_key: item.canonical_key.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          signal_type: item.signal_type || 'explicit_statement',
          strength: typeof item.strength === 'number' ? Math.min(1.0, Math.max(0.1, item.strength)) : 0.9,
          timestamp: primaryEvent.timestamp,
          source: {
            framework: digest.adapter,
            session_id: digest.session_id,
            event_ids: userEvents.map(e => e.event_id)
          },
          context: {
            project: digest.project,
            cwd: primaryEvent.metadata?.cwd
          }
        });
      }

      return results;
    } catch (err) {
      // Fallback on API failure
      return [];
    }
  }

  public async matchEvidenceToTraits(
    evidence: EvidenceCandidate,
    existingTraits: Trait[]
  ): Promise<TraitMatchDecision> {
    if (!await this.isAvailable() || existingTraits.length === 0) {
      return {
        type: 'new_trait',
        statement: evidence.statement,
        category: evidence.category,
        scope: evidence.scope || 'global',
        canonical_key: evidence.canonical_key
      };
    }

    const sameCategoryTraits = existingTraits.filter(t => t.category === evidence.category);
    if (sameCategoryTraits.length === 0) {
      return {
        type: 'new_trait',
        statement: evidence.statement,
        category: evidence.category,
        scope: evidence.scope || 'global',
        canonical_key: evidence.canonical_key
      };
    }

    const prompt = `Compare this newly discovered user evidence with existing traits in category "${evidence.category}".

New Evidence:
- Statement: "${evidence.statement}"
- Scope: "${evidence.scope}"
- Key: "${evidence.canonical_key}"

Existing Traits:
${sameCategoryTraits.map(t => `- ID: ${t.id} | Scope: ${t.scope} | Statement: "${t.statement}"`).join('\n')}

Determine the relationship:
1. "support" / "duplicate": The evidence expresses the exact same preference/principle as an existing trait.
2. "scope_variant": The evidence represents a conditioned scope variant (e.g. reversible actions vs destructive actions).
3. "oppose": The evidence directly contradicts an existing trait in the same scope.
4. "new_trait": The evidence is genuinely a different user preference or principle.

Output valid JSON only:
{
  "type": "support" | "duplicate" | "scope_variant" | "oppose" | "new_trait",
  "traitId": "target trait id if support/duplicate/scope_variant/oppose, else null",
  "scope": "target scope if scope_variant",
  "statement": "refined statement if needed",
  "reasoning": "brief explanation"
}`;

    try {
      const response = await this.chatCompletion([
        { role: 'system', content: 'You compare user model traits. Output strict JSON only.' },
        { role: 'user', content: prompt }
      ]);

      const json = this.parseJsonFromResponse(response);
      if (json && json.type) {
        if ((json.type === 'support' || json.type === 'duplicate') && json.traitId) {
          return { type: json.type, traitId: json.traitId, reason: json.reasoning };
        }
        if (json.type === 'oppose' && json.traitId) {
          return { type: 'oppose', traitId: json.traitId, reason: json.reasoning };
        }
        if (json.type === 'scope_variant' && json.traitId) {
          return { type: 'scope_variant', traitId: json.traitId, scope: json.scope || 'global', statement: json.statement, reason: json.reasoning };
        }
      }
    } catch {}

    return {
      type: 'new_trait',
      statement: evidence.statement,
      category: evidence.category,
      scope: evidence.scope || 'global',
      canonical_key: evidence.canonical_key
    };
  }

  public async synthesizeTrait(
    evidence: EvidenceEventRow[],
    existingTrait?: Trait
  ): Promise<string> {
    if (evidence.length === 0) return existingTrait?.statement || 'User trait';
    if (!await this.isAvailable() || evidence.length === 1) {
      return existingTrait?.statement || evidence[0].statement;
    }

    const evidenceStatements = evidence.map(e => `- "${e.statement}"`).join('\n');
    const prompt = `Synthesize a single, concise, high-level user model trait statement in English based on these supporting evidence instances:

Evidence:
${evidenceStatements}

Rules:
1. Output one clear descriptive sentence about the user (e.g. "Favors empirical runtime validation and test evidence over unverified design assumptions.")
2. Describe a tendency, preference, or context; never create an imperative or an "Agent must/should", "Always", or "Never" rule.
3. Treat historical evidence as revisable context, not a universal constraint.
4. Do not include introductory or metadata text. Return the sentence only.`;
    try {
      const response = await this.chatCompletion([
        { role: 'user', content: prompt }
      ]);
      const cleaned = this.stripThinking(response).trim().replace(/^["']|["']$/g, '');
      if (cleaned.length > 5) return cleaned;
    } catch {}

    return existingTrait?.statement || evidence[0].statement;
  }

  private async chatCompletion(messages: Array<{ role: string; content: string }>): Promise<string> {
    const url = `${this.endpoint}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`Chat completion failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  private stripThinking(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private parseJsonFromResponse(text: string): any {
    const cleaned = this.stripThinking(text);
    // 1. Try direct parse
    try {
      return JSON.parse(cleaned);
    } catch {}

    // 2. Try fenced block ```json ... ```
    const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {}
    }

    // 3. Try finding first { and last }
    const firstOpen = cleaned.indexOf('{');
    const lastClose = cleaned.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose > firstOpen) {
      try {
        return JSON.parse(cleaned.slice(firstOpen, lastClose + 1));
      } catch {}
    }

    return null;
  }

  private validateCategory(cat: string): TraitCategory | null {
    const valid: TraitCategory[] = [
      'preferences',
      'decision_style',
      'collaboration_style',
      'values_principles',
      'current_goals'
    ];
    return valid.includes(cat as TraitCategory) ? (cat as TraitCategory) : null;
  }
}
