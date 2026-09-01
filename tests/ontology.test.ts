import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyTraitOntology, computePortabilityScore } from '../src/traits/ontology.js';
import { renderUserModelMarkdown, writeAllUserModelArtifacts } from '../src/render/user-md.js';
import { renderUserModelJson } from '../src/render/json.js';
import { loadConfig } from '../src/config.js';
import { Trait } from '../src/traits/schema.js';

test('classifyTraitOntology correctly assigns ontology levels and portability scores', () => {
  // 1. USER_GLOBAL
  const globalClass = classifyTraitOntology(
    'decision_style',
    'Favors empirical runtime validation and test evidence over unverified design assumptions.',
    'global',
    3,
    2
  );
  assert.equal(globalClass.ontology, 'USER_GLOBAL');
  assert.ok(globalClass.portability_score >= 0.8);

  // 2. ENVIRONMENT / Path specifics
  const envClass = classifyTraitOntology(
    'preferences',
    'Always execute code through the dedicated .venv environment rather than system Python',
    'global'
  );
  assert.equal(envClass.ontology, 'ENVIRONMENT');
  assert.ok(envClass.portability_score <= 0.4);

  // 3. TOOL policy (Playwright / Chrome)
  const toolClass = classifyTraitOntology(
    'preferences',
    'For browser automation, defaults to Python Playwright in WSL2 using /usr/bin/google-chrome',
    'global'
  );
  assert.equal(toolClass.ontology, 'TOOL');
  assert.equal(toolClass.tool, 'playwright');
  assert.equal(toolClass.scope, 'local-owned-development-environment');

  // 4. PROJECT convention
  const projClass = classifyTraitOntology(
    'preferences',
    'Read this project OpenWiki and AGENTS.md before modifying code in this repository',
    'global'
  );
  assert.equal(projClass.ontology, 'PROJECT');
  assert.ok(projClass.project_id);

  // 5. Identity fact reclassification
  const identityClass = classifyTraitOntology(
    'preferences',
    'User is a 47-year-old male',
    'global'
  );
  assert.notEqual(identityClass.ontology, 'USER_GLOBAL');
});

test('renderUserModelMarkdown excludes tool, environment, and project specifics', () => {
  const mixedTraits: Trait[] = [
    {
      id: 't1',
      category: 'decision_style',
      ontology: 'USER_GLOBAL',
      statement: 'Favors empirical runtime validation over assumptions.',
      scope: 'global',
      status: 'stable',
      confidence: 0.95,
      portability_score: 0.95,
      behavioral_utility: 0.95,
      entailment_score: 0.95,
      semantic_strength: 'direct',
      trait_role: 'ACTION_GUIDANCE',
      support_count: 5,
      contradiction_count: 0,
      distinct_sessions: 5,
      distinct_contexts: 3,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't2',
      category: 'preferences',
      ontology: 'ENVIRONMENT',
      statement: 'Chrome path is /usr/bin/google-chrome in WSL2',
      scope: 'global',
      status: 'stable',
      confidence: 0.95,
      portability_score: 0.2,
      support_count: 5,
      contradiction_count: 0,
      distinct_sessions: 5,
      distinct_contexts: 3,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't3',
      category: 'preferences',
      ontology: 'PROJECT',
      statement: 'Read OpenWiki before modifying RiverBed code',
      scope: 'global',
      status: 'stable',
      confidence: 0.95,
      portability_score: 0.15,
      support_count: 5,
      contradiction_count: 0,
      distinct_sessions: 5,
      distinct_contexts: 3,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    }
  ];

  const userMd = renderUserModelMarkdown(mixedTraits);
  assert.ok(userMd.includes('Favors empirical runtime validation'));
  assert.ok(!userMd.includes('/usr/bin/google-chrome'));
  assert.ok(!userMd.includes('RiverBed'));
});

test('writeAllUserModelArtifacts generates partitioned files properly', () => {
  const tmpHome = path.join(os.tmpdir(), `ont-test-${Date.now()}`);
  const config = loadConfig(tmpHome);

  const sampleTraits: Trait[] = [
    {
      id: 't_g',
      category: 'collaboration_style',
      ontology: 'USER_GLOBAL',
      statement: 'Prefers autonomous progress on reversible work.',
      scope: 'reversible-actions',
      status: 'stable',
      confidence: 0.95,
      portability_score: 0.90,
      support_count: 4,
      contradiction_count: 0,
      distinct_sessions: 4,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_d',
      category: 'preferences',
      ontology: 'DOMAIN',
      domain: 'software-engineering',
      statement: 'Prefers pnpm as package manager for TS projects.',
      scope: 'global',
      status: 'working',
      confidence: 0.85,
      portability_score: 0.70,
      support_count: 2,
      contradiction_count: 0,
      distinct_sessions: 2,
      distinct_contexts: 1,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_t',
      category: 'preferences',
      ontology: 'TOOL',
      tool: 'playwright',
      statement: 'Browser automation defaults to Playwright.',
      scope: 'local-owned-development-environment',
      status: 'stable',
      confidence: 0.90,
      portability_score: 0.40,
      support_count: 4,
      contradiction_count: 0,
      distinct_sessions: 4,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_e',
      category: 'preferences',
      ontology: 'ENVIRONMENT',
      environment: 'wsl2',
      statement: 'System runs on WSL2 Ubuntu environment.',
      scope: 'global',
      status: 'stable',
      confidence: 0.95,
      portability_score: 0.20,
      support_count: 5,
      contradiction_count: 0,
      distinct_sessions: 5,
      distinct_contexts: 2,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    },
    {
      id: 't_p',
      category: 'preferences',
      ontology: 'PROJECT',
      project_id: 'RiverBed',
      statement: 'Review architecture docs before modifying riverbed models.',
      scope: 'global',
      status: 'working',
      confidence: 0.80,
      portability_score: 0.15,
      support_count: 2,
      contradiction_count: 0,
      distinct_sessions: 2,
      distinct_contexts: 1,
      first_seen: '2026-08-01T00:00:00Z',
      last_confirmed: '2026-08-30T00:00:00Z',
      evidence_ids: []
    }
  ];

  writeAllUserModelArtifacts(config, sampleTraits);

  assert.ok(fs.existsSync(config.userMdPath));
  assert.ok(fs.existsSync(config.domainsMdPath));
  assert.ok(fs.existsSync(config.toolsMdPath));
  assert.ok(fs.existsSync(config.environmentMdPath));
  assert.ok(fs.existsSync(path.join(config.projectsDir, 'RiverBed.md')));

  const jsonStr = renderUserModelJson(sampleTraits);
  const jsonObj = JSON.parse(jsonStr);
  assert.equal(jsonObj.ontology_breakdown.USER_GLOBAL, 1);
  assert.equal(jsonObj.ontology_breakdown.DOMAIN, 1);
  assert.equal(jsonObj.ontology_breakdown.TOOL, 1);
  assert.equal(jsonObj.ontology_breakdown.ENVIRONMENT, 1);
  assert.equal(jsonObj.ontology_breakdown.PROJECT, 1);

  fs.rmSync(tmpHome, { recursive: true, force: true });
});
