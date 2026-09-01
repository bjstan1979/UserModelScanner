import fs from 'node:fs';
import path from 'node:path';
import { Trait, OntologyLevel } from '../traits/schema.js';
import { ensureDirectory } from '../config.js';

export interface UserModelJsonOutput {
  version: string;
  generated_at: string;
  trait_count: number;
  ontology_breakdown: Record<OntologyLevel, number>;
  traits: Trait[];
}

export function renderUserModelJson(traits: Trait[], version = '2.0.0'): string {
  const ontologyCounts: Record<OntologyLevel, number> = {
    USER_GLOBAL: 0,
    DOMAIN: 0,
    TOOL: 0,
    ENVIRONMENT: 0,
    PROJECT: 0,
    CURRENT_CONTEXT: 0
  };

  for (const t of traits) {
    if (ontologyCounts[t.ontology] !== undefined) {
      ontologyCounts[t.ontology]++;
    }
  }

  const output: UserModelJsonOutput = {
    version,
    generated_at: new Date().toISOString(),
    trait_count: traits.length,
    ontology_breakdown: ontologyCounts,
    traits
  };
  return JSON.stringify(output, null, 2);
}

export function writeUserModelJson(filePath: string, traits: Trait[], version = '2.0.0'): void {
  ensureDirectory(path.dirname(filePath));
  const content = renderUserModelJson(traits, version);
  fs.writeFileSync(filePath, content, 'utf-8');
}
