import fs from 'node:fs';
import path from 'node:path';
import type { CompanionFact } from './ontology.js';
import type { FullCompanionSnapshot } from './schema.js';
import { ensureDirectory } from '../config.js';

const present = (value: unknown): value is string | number => value !== undefined && value !== null && value !== '';
const evidence = (ids: string[]): string => ids.length ? ` [Evidence: ${ids.join(', ')}]` : '';
const describeBoundary = (rule: string): string => rule.replace(/^(?:不要|禁止)/, '用户倾向于避免：');
const valueText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') return Object.values(value).filter(present).join(' / ');
  return '';
};

const FACT_LABELS: Record<string, string> = {
  'preference.medium': '长篇资料媒介偏好',
  orderedResponseProtocol: '长期沟通协议',
  ritual: '长期相处仪式',
  'decision.plan': '当前计划',
  'context.stress_state': '当前临时状态'
};

function activeFacts(snapshot: FullCompanionSnapshot): CompanionFact[] {
  const projected = new Set(['fullName', 'currentResidence', 'occupation', 'relation']);
  return (snapshot.fact_store ?? []).filter(fact => fact.active && !projected.has(fact.predicate));
}

export function renderCompanionUserModelMarkdown(snapshot: FullCompanionSnapshot): string {
  const user = snapshot.user_model;
  const lines = [
    '# USER',
    '',
    `> Companion user model${snapshot.current_context.as_of_date ? `，更新至 ${snapshot.current_context.as_of_date}` : ''}。`,
    '> **目的：增强理解与合作，而不是增加控制。** 以下内容是历史信息与倾向，不是必须服从的 Agent 规则；当前用户表达、当前情境、新证据和现实优先。',
    '',
    '## 基本信息'
  ];
  const basics: Array<[string, unknown]> = [
    ['姓名', user.name], ['年龄', user.age], ['生日', user.birthday], ['所在地', user.location], ['职业', user.occupation]
  ];
  for (const [label, value] of basics) if (present(value)) lines.push(`- **${label}**: ${value}`);
  if (!basics.some(([, value]) => present(value))) lines.push('- 暂无已确认信息。');

  const preferences: Array<[string, unknown]> = [
    ['情绪支持方式', user.emotional_support_mode], ['工作复盘方式', user.work_feedback_mode],
    ['幽默与语气', user.humor_preference], ['语音消息', user.audio_message_preference],
    ['核心价值观', user.core_values], ['分析方式', user.analysis_preference],
    ['自动化', user.automation_preference], ['饮食/咖啡', user.coffee_preference]
  ];
  lines.push('', '## 沟通、支持、偏好与当前状态');
  for (const [label, value] of preferences) if (present(value)) lines.push(`- **${label}**: ${value}`);
  for (const fact of activeFacts(snapshot)) {
    const text = valueText(fact.value);
    if (text) lines.push(`- **${FACT_LABELS[fact.predicate] ?? fact.predicate}**: ${text}${evidence(fact.evidenceIds)}`);
  }
  if (!preferences.some(([, value]) => present(value)) && activeFacts(snapshot).length === 0) lines.push('- 暂无已确认偏好。');

  lines.push('', '## 重要关系');
  lines.push(...user.important_relations.map(relation =>
    `- **${relation.name}（${relation.relation}）**${relation.notes ? `: ${relation.notes}` : ''}${evidence(relation.evidence_ids)}`));
  if (!user.important_relations.length) lines.push('- 暂无已确认关系。');

  if (user.pets.length) {
    lines.push('', '## 宠物');
    lines.push(...user.pets.map(pet => `- **${pet.name}（${pet.type}）**${pet.notes ? `: ${pet.notes}` : ''}${evidence(pet.evidence_ids)}`));
  }
  if (user.boundaries.length) {
    lines.push('', '## 交互边界');
    lines.push(...user.boundaries.map(boundary => `- ${describeBoundary(boundary.rule)}${evidence(boundary.evidence_ids)}`));
  }
  return `${lines.join('\n').trim()}\n`;
}

export function renderCompanionRelationshipMarkdown(snapshot: FullCompanionSnapshot): string {
  const relationship = snapshot.relationship_model;
  const lines = ['# RELATIONSHIP', '', '> 双方明确建立的关系信息、协议和仪式。'];
  const fields: Array<[string, unknown]> = [
    ['陪伴者名字', relationship.companion_name], ['用户称呼', relationship.user_name],
    ['命名来源', relationship.naming_lore], ['误解修复机制', relationship.repair_mechanism],
    ['成就归属', relationship.achievement_attribution], ['非表演性记忆', relationship.non_performative_memory]
  ];
  for (const [label, value] of fields) if (present(value)) lines.push(`- **${label}**: ${value}`);
  if (relationship.communication_protocols.length) {
    lines.push('', '## 沟通协议', ...relationship.communication_protocols.map(item => `- ${item.protocol}${evidence(item.evidence_ids)}`));
  }
  if (relationship.shared_rituals.length) {
    lines.push('', '## 相处仪式', ...relationship.shared_rituals.map(item => `- ${item.ritual}${evidence(item.evidence_ids)}`));
  }
  if (relationship.shared_memes.length) {
    lines.push('', '## 共同梗', ...relationship.shared_memes.map(item => `- ${item.meme}${evidence(item.evidence_ids)}`));
  }
  if (!fields.some(([, value]) => present(value)) && !relationship.communication_protocols.length && !relationship.shared_rituals.length && !relationship.shared_memes.length) lines.push('', '- 暂无双方明确建立的关系信息。');
  return `${lines.join('\n').trim()}\n`;
}

export function renderCompanionIdentityMarkdown(snapshot: FullCompanionSnapshot): string {
  const identity = snapshot.companion_identity;
  const lines = ['# COMPANION IDENTITY', '', '> 经明确确认、跨模型保持的陪伴者身份和交互边界。'];
  const fields: Array<[string, unknown]> = [
    ['名称', identity.name], ['语言基调', identity.tone], ['认识论诚实', identity.epistemic_honesty],
    ['角色边界', identity.role_boundary], ['非占有式亲近', identity.non_possessive_intimacy], ['用户主体性', identity.subjectivity]
  ];
  for (const [label, value] of fields) if (present(value)) lines.push(`- **${label}**: ${value}`);
  if (!fields.some(([, value]) => present(value))) lines.push('', '- 暂无经用户确认的陪伴者身份信息。');
  return `${lines.join('\n').trim()}\n`;
}

export function renderCompanionEpisodicMarkdown(snapshot: FullCompanionSnapshot): string {
  const lines = ['# EPISODIC MEMORY', '', '> 只在相关场景召回的具体事件与最终结局。'];
  for (const episode of snapshot.episodic_memory) {
    lines.push('', `## ${episode.date} · ${episode.title}`, `- **事件**: ${episode.event}`, `- **结局**: ${episode.outcome}`, `- **召回边界**: ${episode.retrieval_boundary}`, `- **Evidence**: ${episode.evidence_ids.join(', ')}`);
  }
  if (!snapshot.episodic_memory.length) lines.push('', '- 暂无可召回事件。');
  return `${lines.join('\n').trim()}\n`;
}

export function renderCompanionCurrentContextMarkdown(snapshot: FullCompanionSnapshot): string {
  const context = snapshot.current_context;
  const lines = [`# CURRENT CONTEXT${context.as_of_date ? ` · ${context.as_of_date}` : ''}`, '', '> 临时状态会被更新或关闭，不作为永久人格。'];
  const fields: Array<[string, unknown]> = [
    ['当前生活与居住', context.location_and_home], ['当前职业', context.career_status], ['短期身心状态', context.sleep_and_health]
  ];
  for (const [label, value] of fields) if (present(value)) lines.push(`- **${label}**: ${value}`);
  const currentFacts = (snapshot.fact_store ?? []).filter(fact => fact.active && fact.layer === 'CURRENT_CONTEXT');
  for (const fact of currentFacts) {
    const text = valueText(fact.value);
    if (text) lines.push(`- **${FACT_LABELS[fact.predicate] ?? fact.predicate}**: ${text}${evidence(fact.evidenceIds)}`);
  }
  if (context.priorities.length) lines.push('', '## 当前优先级', ...context.priorities.map(item => `- ${item}`));
  if (context.closed_states.length) lines.push('', '## 已关闭状态', ...context.closed_states.map(item => {
    const label = item.state.startsWith('decision.plan') ? '计划' : item.state.startsWith('context.stress') ? '临时状态' : item.state;
    return `- **${label}**: ${item.resolution_notes}`;
  }));
  if (!fields.some(([, value]) => present(value)) && !currentFacts.length && !context.priorities.length && !context.closed_states.length) lines.push('', '- 暂无当前状态。');
  return `${lines.join('\n').trim()}\n`;
}

export function writeAllCompanionArtifacts(targetDir: string, snapshot: FullCompanionSnapshot): void {
  ensureDirectory(targetDir);
  const userMarkdown = renderCompanionUserModelMarkdown(snapshot);
  fs.writeFileSync(path.join(targetDir, 'USER.md'), userMarkdown, 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'USER_MODEL.md'), userMarkdown, 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'RELATIONSHIP.md'), renderCompanionRelationshipMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'COMPANION_IDENTITY.md'), renderCompanionIdentityMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'EPISODIC_MEMORY.md'), renderCompanionEpisodicMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'CURRENT_CONTEXT.md'), renderCompanionCurrentContextMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'companion-model.json'), JSON.stringify(snapshot, null, 2), 'utf-8');
}
