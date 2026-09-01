import fs from 'node:fs';
import path from 'node:path';
import { FullCompanionSnapshot } from './schema.js';
import { ensureDirectory } from '../config.js';

export function renderCompanionUserModelMarkdown(snapshot: FullCompanionSnapshot): string {
  const u = snapshot.user_model;
  const lines: string[] = [
    '# Companion User Model (用户模型)',
    `> 截至 ${snapshot.current_context.as_of_date} 的 Canonical 状态。严格基于真实互动证据提炼，杜绝未经证实的人格标签与虚假回忆。`,
    '',
    '## 1. 核心事实与背景 (Core Background)',
    `- **姓名**: ${u.name}`,
    `- **年龄与生日**: ${u.age}岁 (生日: ${u.birthday})`,
    `- **居住与成长**: ${u.location}`,
    `- **职业与发展**: ${u.occupation}`,
    '',
    '## 2. 情绪与沟通模式 (Emotional & Communication Style)',
    `- **情绪支持模式**: ${u.emotional_support_mode}`,
    `- **工作复盘模式**: ${u.work_feedback_mode}`,
    `- **幽默与语气偏好**: ${u.humor_preference}`,
    `- **语音消息偏好**: ${u.audio_message_preference}`,
    '',
    '## 3. 认知、决策与偏好 (Decision, Values & Preferences)',
    `- **核心价值观**: ${u.core_values}`,
    `- **分析偏好**: ${u.analysis_preference}`,
    `- **自动化偏好**: ${u.automation_preference}`,
    `- **饮食/咖啡偏好**: ${u.coffee_preference}`,
    '',
    '## 4. 重要人物圈 (Important Relationships)',
    ...u.important_relations.map(r => `- **${r.name} (${r.relation})**: ${r.notes || ''} [Evidence: ${r.evidence_ids.join(', ')}]`),
    '',
    '## 5. 宠物伙伴 (Pets)',
    ...u.pets.map(p => `- **${p.name} (${p.type})**: ${p.notes || ''} [Evidence: ${p.evidence_ids.join(', ')}]`),
    '',
    '## 6. 交互底线与敏感区 (Boundaries & Restraint)',
    ...u.boundaries.map(b => `- ${b.rule} [Evidence: ${b.evidence_ids.join(', ')}]`),
    ''
  ];

  return lines.join('\n').trim() + '\n';
}

export function renderCompanionRelationshipMarkdown(snapshot: FullCompanionSnapshot): string {
  const r = snapshot.relationship_model;
  const lines: string[] = [
    '# Relationship Model (关系模型)',
    "> 记录双方共同确立的相处仪式、专属称呼、修复机制与关系边界。",
    '',
    '## 1. 专属命名与隐喻 (Naming & Lore)',
    `- **陪伴者名字**: ${r.companion_name}`,
    `- **用户专属称呼**: ${r.user_name}`,
    `- **命名由来源起**: ${r.naming_lore}`,
    '',
    '## 2. 共同仪式 (Shared Rituals)',
    ...r.shared_rituals.map(sr => `- ${sr.ritual} [Evidence: ${sr.evidence_ids.join(', ')}]`),
    '',
    '## 3. 共同梗 (Shared Memes)',
    ...r.shared_memes.map(sm => `- ${sm.meme} [Evidence: ${sm.evidence_ids.join(', ')}]`),
    '',
    '## 4. 沟通协议 (Communication Protocols)',
    ...r.communication_protocols.map(cp => `- ${cp.protocol} [Evidence: ${cp.evidence_ids.join(', ')}]`),
    '',
    '## 5. 误解修复机制 (Repair Mechanism)',
    `- ${r.repair_mechanism}`,
    '',
    '## 6. 关系边界 (Relational Boundaries)',
    `- **成就归属**: ${r.achievement_attribution}`,
    `- **非表演性记忆**: ${r.non_performative_memory}`,
    ''
  ];

  return lines.join('\n').trim() + '\n';
}

export function renderCompanionIdentityMarkdown(snapshot: FullCompanionSnapshot): string {
  const i = snapshot.companion_identity;
  const lines: string[] = [
    '# Companion Identity / Soul (陪伴者人设与认识论)',
    `> 无论底层模型如何更换升级，${snapshot.companion_identity.name || '陪伴者'}的语言基调、认识论边界与交互风格保持一致。`,
    '',
    '## 1. 形象与基调 (Identity & Tone)',
    `- **名称**: ${i.name}`,
    `- **语言基调**: ${i.tone}`,
    '',
    '## 2. 认识论诚实 (Epistemic Honesty)',
    `- ${i.epistemic_honesty}`,
    '',
    '## 3. 角色边界 (Role Boundaries)',
    `- ${i.role_boundary}`,
    '',
    '## 4. 交互边界 (Interactive Boundaries)',
    `- **非占有式亲近**: ${i.non_possessive_intimacy}`,
    `- **主体性与决策权**: ${i.subjectivity}`,
    ''
  ];

  return lines.join('\n').trim() + '\n';
}

export function renderCompanionEpisodicMarkdown(snapshot: FullCompanionSnapshot): string {
  const lines: string[] = [
    '# Episodic Memory (情境与事件记忆)',
    "> 记录具体经历与最终结局。仅在相关场景时召回，严格克制在无关情境翻旧账。",
    ''
  ];

  for (const ep of snapshot.episodic_memory) {
    lines.push(`## [${ep.id}] ${ep.date} · ${ep.title}`);
    lines.push(`- **事件**: ${ep.event}`);
    lines.push(`- **最终结局**: ${ep.outcome}`);
    lines.push(`- **检索与提取边界**: ${ep.retrieval_boundary}`);
    lines.push(`- **证据来源**: ${ep.evidence_ids.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

export function renderCompanionCurrentContextMarkdown(snapshot: FullCompanionSnapshot): string {
  const c = snapshot.current_context;
  const lines: string[] = [
    `# Current Context (截至 ${c.as_of_date} 的当前状态)`,
    "> 短期状态具备有效期限（TTL），随时间自然衰减或被后续事实关闭，不作为永久人格特征。",
    '',
    '## 1. 当前生活与居住',
    `- ${c.location_and_home}`,
    '',
    '## 2. 当前职业与交接',
    `- ${c.career_status}`,
    '',
    '## 3. 现阶段优先级',
    ...c.priorities.map(p => `- ${p}`),
    '',
    '## 4. 短期身心状态 (带衰减与复核)',
    `- ${c.sleep_and_health}`,
    '',
    '## 5. 已经关闭/过期的历史临时状态 (Closed Past States)',
    ...c.closed_states.map(cs => `- [已关闭] **${cs.state}**: ${cs.resolution_notes}`),
    ''
  ];

  return lines.join('\n').trim() + '\n';
}

export function writeAllCompanionArtifacts(targetDir: string, snapshot: FullCompanionSnapshot): void {
  ensureDirectory(targetDir);

  fs.writeFileSync(path.join(targetDir, 'USER_MODEL.md'), renderCompanionUserModelMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'RELATIONSHIP.md'), renderCompanionRelationshipMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'COMPANION_IDENTITY.md'), renderCompanionIdentityMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'EPISODIC_MEMORY.md'), renderCompanionEpisodicMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'CURRENT_CONTEXT.md'), renderCompanionCurrentContextMarkdown(snapshot), 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'companion-model.json'), JSON.stringify(snapshot, null, 2), 'utf-8');
}
