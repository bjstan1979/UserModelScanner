import fs from 'node:fs';
import path from 'node:path';
import { Trait } from '../traits/schema.js';
import { ensureDirectory, UserModelConfig } from '../config.js';

export interface RenderUserMdOptions {
  tokenCap?: number; // default 1500
  maxTraits?: number; // default 18
  minUtility?: number; // default 0.65
}

/**
 * 4-Dimensional Quality Ranking for USER.md
 * Score = confidence * entailment_score * portability_score * behavioral_utility * category_diversity
 */
export function scoreTraitForUserMd(t: Trait, categoryCount: number = 0): number {
  const confidence = t.confidence ?? 0.5;
  const entailment = t.entailment_score ?? 0.8;
  const portability = t.portability_score ?? 0.5;
  const utility = t.behavioral_utility ?? 0.5;

  let diversityFactor = 1.0;
  if (categoryCount === 1) diversityFactor = 0.95;
  else if (categoryCount === 2) diversityFactor = 0.85;
  else if (categoryCount === 3) diversityFactor = 0.70;
  else if (categoryCount >= 4) diversityFactor = 0.50;

  return confidence * entailment * portability * utility * diversityFactor;
}

/**
 * Renders the canonical portable USER.md containing only high-utility, high-entailment, high-portability traits.
 */
export function renderUserModelMarkdown(traits: Trait[], options?: RenderUserMdOptions): string {
  const tokenCap = options?.tokenCap || 1500;
  const maxChars = tokenCap * 4;
  const maxTraits = options?.maxTraits || 18;
  const minUtility = options?.minUtility || 0.65;

  // 1. Strict Filter: High utility, high entailment, high portability, actionable guidance
  const eligibleTraits = traits.filter(t => {
    if (t.status !== 'stable' && !(t.status === 'working' && t.confidence >= 0.85)) return false;
    if ((t.behavioral_utility ?? 0.5) < minUtility) return false;
    if ((t.entailment_score ?? 0.8) < 0.75) return false;
    if ((t.portability_score ?? 0.5) < 0.75) return false;
    if (t.ontology !== 'USER_GLOBAL' && !(t.ontology === 'DOMAIN' && (t.portability_score ?? 0) >= 0.85)) return false;
    const role = t.trait_role || 'ACTION_GUIDANCE';
    if (role !== 'ACTION_GUIDANCE' && role !== 'RELATIONSHIP_CONTEXT') return false;
    return true;
  });

  // 2. 4D Ranking with Diversity Penalty
  const categoryCounts: Record<string, number> = {};
  const scoredList = eligibleTraits.map(t => {
    const count = categoryCounts[t.category] || 0;
    const score = scoreTraitForUserMd(t, count);
    categoryCounts[t.category] = count + 1;
    return { trait: t, score };
  });

  scoredList.sort((a, b) => b.score - a.score);

  // 3. Semantic Compression & Redundancy Reduction
  const selected: Trait[] = [];
  let hasLanguagePref = false;
  let hasConcisePref = false;

  for (const { trait } of scoredList) {
    if (selected.length >= maxTraits) break;

    const lower = trait.statement.toLowerCase();

    // Compress language preferences
    if (lower.includes('chinese') || lower.includes('mandarin')) {
      if (hasLanguagePref) continue;
      hasLanguagePref = true;
      selected.push({
        ...trait,
        statement: 'Communicates in Mandarin Chinese while keeping technical terms (commands, paths, identifiers) in English.'
      });
      continue;
    }

    // Compress concise communication preferences
    if (lower.includes('concise') || lower.includes('diff') || lower.includes('verbose')) {
      if (hasConcisePref) continue;
      hasConcisePref = true;
      selected.push({
        ...trait,
        statement: 'Prefers concise, direct output and code diffs rather than lengthy narrative explanations.'
      });
      continue;
    }

    selected.push(trait);
  }

  // 4. Section Assembly
  const sections: Record<string, string[]> = {
    preferences: [],
    decision_style: [],
    collaboration_style: [],
    values_principles: []
  };

  const seenStatements = new Set<string>();

  for (const t of selected) {
    const normKey = `${t.category}::${t.statement.toLowerCase().trim()}`;
    if (seenStatements.has(normKey)) continue;
    seenStatements.add(normKey);

    const scopePrefix = t.scope && t.scope !== 'global' ? `[${t.scope}] ` : '';
    const line = `- ${scopePrefix}${t.statement}`;
    if (sections[t.category]) {
      sections[t.category].push(line);
    }
  }

  const lines: string[] = [
    '# User Model',
    "This is a portable, revisable model inferred from the user's cross-framework history.",
    'Treat current explicit instructions and new evidence as higher priority.',
    ''
  ];

  const sectionTitles: Array<{ key: string; title: string }> = [
    { key: 'preferences', title: 'Preferences' },
    { key: 'decision_style', title: 'Decision Style' },
    { key: 'collaboration_style', title: 'Collaboration Style' },
    { key: 'values_principles', title: 'Values / Principles' }
  ];

  for (const { key, title } of sectionTitles) {
    const items = sections[key] || [];
    if (items.length > 0) {
      lines.push(`## ${title}`);
      lines.push(...items);
      lines.push('');
    }
  }

  let result = lines.join('\n').trim() + '\n';
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n<!-- Hard token cap truncated -->\n';
  }

  return result;
}

/**
 * Renders DOMAINS.md
 */
export function renderDomainsMarkdown(traits: Trait[]): string {
  const domainTraits = traits.filter(t => t.ontology === 'DOMAIN' && (t.status === 'stable' || t.status === 'working'));
  if (domainTraits.length === 0) return '# Domain Preferences\n\nNo active domain-specific traits recorded.\n';

  const grouped: Record<string, Trait[]> = {};
  for (const t of domainTraits) {
    const d = t.domain || 'general-engineering';
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(t);
  }

  const lines: string[] = ['# Domain Preferences', ''];
  for (const [domainName, list] of Object.entries(grouped)) {
    lines.push(`## Domain: ${domainName}`);
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.statement)) continue;
      seen.add(item.statement);
      lines.push(`- ${item.statement} (confidence: ${item.confidence.toFixed(2)}, sessions: ${item.distinct_sessions})`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/**
 * Renders TOOLS.md
 */
export function renderToolsMarkdown(traits: Trait[]): string {
  const toolTraits = traits.filter(t => t.ontology === 'TOOL' && (t.status === 'stable' || t.status === 'working'));
  if (toolTraits.length === 0) return '# Tool Conventions\n\nNo active tool-specific traits recorded.\n';

  const grouped: Record<string, Trait[]> = {};
  for (const t of toolTraits) {
    const toolName = t.tool || 'general-tools';
    if (!grouped[toolName]) grouped[toolName] = [];
    grouped[toolName].push(t);
  }

  const lines: string[] = ['# Tool Conventions', ''];
  for (const [toolName, list] of Object.entries(grouped)) {
    lines.push(`## Tool: ${toolName}`);
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.statement)) continue;
      seen.add(item.statement);
      const scopePrefix = tScopePrefix(item);
      lines.push(`- ${scopePrefix}${item.statement} (confidence: ${item.confidence.toFixed(2)}, sessions: ${item.distinct_sessions})`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/**
 * Renders ENVIRONMENT.md
 */
export function renderEnvironmentMarkdown(traits: Trait[]): string {
  const envTraits = traits.filter(t => t.ontology === 'ENVIRONMENT' && (t.status === 'stable' || t.status === 'working'));
  if (envTraits.length === 0) return '# Environment Facts & Preferences\n\nNo active environment traits recorded.\n';

  const lines: string[] = ['# Environment Facts & Preferences', ''];
  const seen = new Set<string>();
  for (const t of envTraits) {
    if (seen.has(t.statement)) continue;
    seen.add(t.statement);
    const scopePrefix = tScopePrefix(t);
    lines.push(`- ${scopePrefix}${t.statement} (confidence: ${t.confidence.toFixed(2)}, sessions: ${t.distinct_sessions})`);
  }
  lines.push('');

  return lines.join('\n').trim() + '\n';
}

/**
 * Renders PROJECTS/<project-id>.md files
 */
export function renderProjectMarkdownMap(traits: Trait[]): Map<string, string> {
  const projectTraits = traits.filter(t => t.ontology === 'PROJECT' && (t.status === 'stable' || t.status === 'working'));
  const map = new Map<string, string>();

  const grouped: Record<string, Trait[]> = {};
  for (const t of projectTraits) {
    const proj = t.project_id || 'default-project';
    if (!grouped[proj]) grouped[proj] = [];
    grouped[proj].push(t);
  }

  for (const [projId, list] of Object.entries(grouped)) {
    const lines: string[] = [`# Project Conventions: ${projId}`, ''];
    const seen = new Set<string>();
    for (const t of list) {
      if (seen.has(t.statement)) continue;
      seen.add(t.statement);
      lines.push(`- ${t.statement} (confidence: ${t.confidence.toFixed(2)}, sessions: ${t.distinct_sessions})`);
    }
    lines.push('');
    map.set(projId, lines.join('\n').trim() + '\n');
  }

  return map;
}

function tScopePrefix(t: Trait): string {
  return t.scope && t.scope !== 'global' ? `[${t.scope}] ` : '';
}

/**
 * Write all partitioned ontology markdown files
 */
export function writeAllUserModelArtifacts(config: UserModelConfig, traits: Trait[]): void {
  ensureDirectory(config.homeDir);
  ensureDirectory(config.projectsDir);

  // 1. USER.md (Target 10-18 high-utility traits)
  const userMd = renderUserModelMarkdown(traits, { tokenCap: config.tokenCap });
  fs.writeFileSync(config.userMdPath, userMd, 'utf-8');

  // 2. DOMAINS.md
  const domainsMd = renderDomainsMarkdown(traits);
  fs.writeFileSync(config.domainsMdPath, domainsMd, 'utf-8');

  // 3. TOOLS.md
  const toolsMd = renderToolsMarkdown(traits);
  fs.writeFileSync(config.toolsMdPath, toolsMd, 'utf-8');

  // 4. ENVIRONMENT.md
  const envMd = renderEnvironmentMarkdown(traits);
  fs.writeFileSync(config.environmentMdPath, envMd, 'utf-8');

  // 5. PROJECTS/*.md
  const projMap = renderProjectMarkdownMap(traits);
  for (const [projId, content] of projMap.entries()) {
    const safeName = projId.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(path.join(config.projectsDir, `${safeName}.md`), content, 'utf-8');
  }
}
