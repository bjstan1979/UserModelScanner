import { OntologyLevel, Trait, TraitRole, SemanticStrength } from './schema.js';
import { EvidenceCandidate, TraitCategory } from '../evidence/extract.js';
import { evaluateTraitQuality } from './quality.js';

export interface ClassifiedOntology {
  category: TraitCategory;
  ontology: OntologyLevel;
  domain?: string | null;
  tool?: string | null;
  environment?: string | null;
  project_id?: string | null;
  scope: string;
  portability_score: number;
  behavioral_utility: number;
  entailment_score: number;
  semantic_strength: SemanticStrength;
  trait_role: TraitRole;
  statement: string;
}

export function classifyTraitOntology(
  rawCategory: TraitCategory,
  rawStatement: string,
  rawScope: string = 'global',
  distinctProjects = 1,
  distinctFrameworks = 1,
  supportCount = 1,
  hint?: {
    ontology?: string;
    domain?: string;
    tool?: string;
    environment?: string;
    projectId?: string;
  }
): ClassifiedOntology {
  const statement = rawStatement.trim();
  const lower = statement.toLowerCase();

  let category: TraitCategory = rawCategory;
  let ontology: OntologyLevel = 'USER_GLOBAL';
  let domain: string | null = hint?.domain || null;
  let tool: string | null = hint?.tool || null;
  let environment: string | null = hint?.environment || null;
  let projectId: string | null = hint?.projectId || null;
  let scope = rawScope;
  let refinedStatement = statement;

  // 0. Canonical Category & Scope Normalization
  if (lower.includes('autonomous') || lower.includes('without asking') || lower.includes('without confirmation') || lower.includes('proceed directly') || lower.includes('自主') || lower.includes('直接做')) {
    category = 'collaboration_style';
    scope = 'reversible-actions';
    refinedStatement = 'For reversible local engineering work, prefers autonomous progress without redundant confirmation.';
  } else if (lower.includes('destructive') || lower.includes('irreversible') || lower.includes('高危') || lower.includes('删库') || lower.includes('破坏性')) {
    category = 'collaboration_style';
    scope = 'destructive-actions';
    refinedStatement = 'For irreversible, destructive, or externally consequential actions, prefers stronger safeguards and explicit boundaries.';
  } else if (lower.includes('empirical') || lower.includes('runtime validation') || lower.includes('test evidence over') || lower.includes('以运行结果为准')) {
    category = 'decision_style';
    refinedStatement = 'Favors empirical runtime validation and test evidence over unverified design assumptions.';
  } else if (lower.includes('thin runtime') || lower.includes('decoupled from heavy offline')) {
    category = 'values_principles';
    refinedStatement = 'Believes in keeping the agent runtime thin, lightweight, and decoupled from heavy offline processes.';
  } else if (lower.includes('pruning unnecessary complexity') || lower.includes('delete complexity if no value') || lower.includes('没有收益就删掉复杂度')) {
    category = 'values_principles';
    refinedStatement = 'Insists on pruning unnecessary complexity when an abstraction does not show demonstrable utility.';
  }

  // 1. Current Context Check
  if (category === 'current_goals' || lower.includes('active priority') || lower.includes('current focus')) {
    ontology = 'CURRENT_CONTEXT';
    scope = 'global';
  }

  // 2. Machine / Local Environment Facts & Paths
  else if (
    lower.includes('/usr/bin') ||
    lower.includes('.venv') ||
    lower.includes('system interpreter') ||
    lower.includes('wsl2') ||
    lower.includes('/tmp') ||
    lower.includes('persistent path') ||
    lower.includes('provider profile') ||
    lower.includes('system-default python') ||
    lower.includes('homebrew')
  ) {
    environment = lower.includes('wsl2') ? 'wsl2' : (lower.includes('.venv') ? 'python-venv' : 'local-system');
    
    // Check if it's browser automation tool policy
    if (lower.includes('playwright') || lower.includes('chrome') || lower.includes('browser automation') || lower.includes('web-access')) {
      ontology = 'TOOL';
      tool = 'playwright';
      scope = 'local-owned-development-environment';
      refinedStatement = 'Browser automation defaults to Python Playwright in WSL2 using system Chrome (/usr/bin/google-chrome); web-access, CDP proxy, and remote-debugging are opt-in only.';
    } else {
      ontology = 'ENVIRONMENT';
    }
  }

  // 3. Tool Policy & Conventions
  else if (
    lower.includes('playwright') ||
    lower.includes('anysearch') ||
    lower.includes('web-access') ||
    lower.includes('cdp proxy') ||
    lower.includes('remote-debugging') ||
    lower.includes('mmx') ||
    lower.includes('hcom') ||
    lower.includes('langgraph studio') ||
    lower.includes('tui')
  ) {
    ontology = 'TOOL';
    if (lower.includes('playwright') || lower.includes('web-access') || lower.includes('cdp')) {
      tool = 'playwright';
      scope = 'local-owned-development-environment';
      refinedStatement = 'Browser automation defaults to Python Playwright in WSL2 using system Chrome (/usr/bin/google-chrome); web-access, CDP proxy, and remote-debugging are opt-in only.';
    } else if (lower.includes('anysearch')) {
      tool = 'anysearch';
      refinedStatement = 'Prefers anysearch over mmx for public web searches in pi.';
    } else {
      tool = 'tooling';
    }
  }

  // 4. Project-Specific Conventions
  else if (
    lower.includes('openwiki') ||
    lower.includes('agents.md') ||
    lower.includes('this repository') ||
    lower.includes('this project') ||
    lower.includes('riverbed') ||
    lower.includes('arc-agi') ||
    lower.includes('freedom-agent') ||
    lower.includes('position-plugin')
  ) {
    ontology = 'PROJECT';
    projectId = extractProjectName(lower);
  }

  // 5. Non-sandbox / Sandbox boundary -> ENVIRONMENT (local-owned-development-environment)
  else if (lower.includes('non-sandbox') || lower.includes('sandbox execution') || lower.includes('danger-full-access') || lower.includes('outside of a sandbox')) {
    ontology = 'ENVIRONMENT';
    environment = 'local-development';
    scope = 'local-owned-development-environment';
    refinedStatement = 'In locally-owned development environments, prefers direct non-sandbox execution for sustained engineering workflows.';
  }

  // 6. Code Review / Investigation / Software Engineering Specifics -> DOMAIN: software-engineering
  else if (
    lower.includes('code review') ||
    lower.includes('adversarial read-only') ||
    lower.includes('read-only investigation') ||
    lower.includes('invariants/correctness') ||
    lower.includes('severity') ||
    lower.includes('git commit') ||
    lower.includes('commit and push') ||
    lower.includes('pnpm') ||
    lower.includes('typescript') ||
    lower.includes('package manager') ||
    lower.includes('isolation testing') ||
    lower.includes('a/b testing') ||
    lower.includes('root cause') ||
    lower.includes('root-cause')
  ) {
    ontology = 'DOMAIN';
    domain = 'software-engineering';
  }

  // 7. AI Emotion / Subjectivity / Inner-state beliefs -> DOMAIN: agent-design
  else if (
    lower.includes('may have') ||
    lower.includes('emotions') ||
    lower.includes('inner states') ||
    lower.includes('subjectivity') ||
    lower.includes('self-introspection')
  ) {
    ontology = 'DOMAIN';
    domain = 'agent-design';
    refinedStatement = "Prefers AI agents to adopt an open 'may have' stance toward questions of their own functional or emotional states, avoiding both flat denial and forced certainty.";
  }

  // 8. Core USER_GLOBAL Personal Cognitive & Collaboration Principles
  else {
    ontology = 'USER_GLOBAL';
  }

  // Identity filtering
  if (lower.includes('year-old') || lower.includes('male') || lower.includes('female')) {
    ontology = 'ENVIRONMENT';
  }

  // Evaluate Quality, Utility, Entailment, and Wording Calibration
  const quality = evaluateTraitQuality(category, refinedStatement, ontology, supportCount);
  const portability_score = computePortabilityScore(ontology, quality.calibratedStatement, distinctProjects, distinctFrameworks);

  return {
    category,
    ontology,
    domain,
    tool,
    environment,
    project_id: projectId,
    scope,
    portability_score,
    behavioral_utility: quality.behavioral_utility,
    entailment_score: quality.entailment_score,
    semantic_strength: quality.semantic_strength,
    trait_role: quality.trait_role,
    statement: quality.calibratedStatement
  };
}

export function computePortabilityScore(
  ontology: OntologyLevel,
  statement: string,
  distinctProjects = 1,
  distinctFrameworks = 1
): number {
  let baseScore = 0.5;

  switch (ontology) {
    case 'USER_GLOBAL':
      baseScore = 0.88;
      break;
    case 'DOMAIN':
      baseScore = 0.68;
      break;
    case 'TOOL':
      baseScore = 0.42;
      break;
    case 'ENVIRONMENT':
      baseScore = 0.22;
      break;
    case 'PROJECT':
      baseScore = 0.12;
      break;
    case 'CURRENT_CONTEXT':
      baseScore = 0.10;
      break;
  }

  // Bonus for cross-project and cross-framework observation
  const projectBonus = Math.min(0.08, (distinctProjects - 1) * 0.04);
  const frameworkBonus = Math.min(0.08, (distinctFrameworks - 1) * 0.04);

  // Penalty for local paths / machine specifics
  const lower = statement.toLowerCase();
  let penalty = 0.0;
  if (lower.includes('/usr/bin') || lower.includes('/tmp') || lower.includes('wsl2') || lower.includes('.venv')) {
    penalty += 0.20;
  }
  if (lower.includes('year-old') || lower.includes('male') || lower.includes('female')) {
    penalty += 0.30;
  }

  let finalScore = baseScore + projectBonus + frameworkBonus - penalty;
  return Math.min(0.98, Math.max(0.05, Math.round(finalScore * 100) / 100));
}

function extractProjectName(text: string): string | null {
  if (text.includes('openwiki')) return 'openwiki-projects';
  if (text.includes('riverbed')) return 'RiverBed';
  if (text.includes('arc-agi')) return 'ARC-AGI-3';
  if (text.includes('position-plugin')) return 'opencode-position-plugin';
  return 'repo-local';
}
