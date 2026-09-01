import { TraitCategory } from '../evidence/extract.js';
import { OntologyLevel, TraitRole, SemanticStrength } from './schema.js';

export interface TraitQualityEvaluation {
  behavioral_utility: number;
  entailment_score: number;
  semantic_strength: SemanticStrength;
  trait_role: TraitRole;
  calibratedStatement: string;
}

export function calibrateTraitAsPrior(rawStatement: string): string {
  const statement = rawStatement.trim();
  const withoutPeriod = statement.replace(/[.!。]$/, '');
  const agentRule = withoutPeriod.match(/^(?:the\s+)?agent\s+(?:must|should|has to|needs to)\s+(.+)$/i);
  if (agentRule) {
    const preference = agentRule[1].replace(/^always\s+/i, '').replace(/^never\s+/i, 'avoid ');
    return `Usually prefers the agent to ${preference}.`;
  }
  const always = withoutPeriod.match(/^always\s+(?:require|ask for)\s+(.+)$/i);
  if (always) return `Prefers ${always[1]}.`;
  const alwaysTendency = withoutPeriod.match(/^always\s+(.+)$/i);
  if (alwaysTendency) return `Shows a consistent tendency to ${alwaysTendency[1]}.`;
  const doNot = withoutPeriod.match(/^do not\s+(.+)$/i);
  if (doNot) return `Shows a tendency to avoid: ${doNot[1]}.`;
  const never = withoutPeriod.match(/^never\s+(.+)$/i);
  if (never) return `Shows a tendency to avoid: ${never[1]}.`;
  const required = withoutPeriod.match(/^(?:must|requires?)\s+(.+)$/i);
  if (required) return `Shows a strong preference for this outcome: ${required[1]}.`;
  const chineseRequired = withoutPeriod.match(/^必须(.+)$/);
  if (chineseRequired) return `通常重视：${chineseRequired[1]}。`;
  const chineseAvoid = withoutPeriod.match(/^(?:不要|禁止)(.+)$/);
  if (chineseAvoid) return `倾向于避免：${chineseAvoid[1]}。`;
  return statement;
}

/**
 * Calibrates wording to prevent semantic overreach and computes behavioral utility and entailment scores.
 */
export function evaluateTraitQuality(
  category: TraitCategory,
  rawStatement: string,
  ontology: OntologyLevel,
  supportCount: number = 1
): TraitQualityEvaluation {
  const statement = rawStatement.trim();
  const lower = statement.toLowerCase();

  // User Models describe historical tendencies; they do not create agent rules.
  let calibratedStatement = calibrateTraitAsPrior(statement);
  if (calibratedStatement.includes('expects explicit confirmation') && !lower.includes('destructive-actions')) {
    calibratedStatement = calibratedStatement.replace(
      /expects explicit confirmation/gi,
      'prefers stronger safeguards and explicit boundaries'
    );
  }

  if (calibratedStatement.includes('must be') || calibratedStatement.includes('must not')) {
    calibratedStatement = calibratedStatement.replace(/\bmust be\b/gi, 'is usually expected to be').replace(/\bmust not\b/gi, 'is usually avoided');
  }
  // 2. Determine Trait Role
  let trait_role: TraitRole = 'ACTION_GUIDANCE';
  if (ontology === 'ENVIRONMENT') {
    trait_role = 'ENVIRONMENT_FACT';
  } else if (ontology === 'PROJECT' || ontology === 'DOMAIN' || ontology === 'TOOL') {
    trait_role = 'DOMAIN_CONVENTION';
  } else if (
    lower.includes('thinking partner') ||
    lower.includes('challenge') ||
    lower.includes('collaborat') ||
    lower.includes('safe framework') ||
    lower.includes('authentic') ||
    lower.includes('stance toward') ||
    lower.includes('relationship')
  ) {
    trait_role = 'RELATIONSHIP_CONTEXT';
  } else {
    trait_role = 'ACTION_GUIDANCE';
  }

  // 3. Compute Behavioral Utility (0.0 - 1.0)
  // High utility: directly changes how an agent acts, communicates, verifies, or seeks approval
  let behavioral_utility = 0.5;

  if (
    lower.includes('empirical') ||
    lower.includes('runtime validation') ||
    lower.includes('test evidence') ||
    lower.includes('autonomous') ||
    lower.includes('without asking') ||
    lower.includes('safeguards') ||
    lower.includes('destructive') ||
    lower.includes('concise') ||
    lower.includes('direct output') ||
    lower.includes('thin runtime') ||
    lower.includes('delete complexity') ||
    lower.includes('pruning unnecessary complexity') ||
    lower.includes('inspect-only') ||
    lower.includes('diagnos') ||
    lower.includes('challenge assumptions')
  ) {
    behavioral_utility = 0.95;
  } else if (
    lower.includes('mandarin') ||
    lower.includes('chinese') ||
    lower.includes('severity') ||
    lower.includes('bounded reports') ||
    lower.includes('pnpm') ||
    lower.includes('typescript')
  ) {
    behavioral_utility = 0.85;
  } else if (
    lower.includes('谢谢') ||
    lower.includes('polite') ||
    lower.includes('appreciative') ||
    lower.includes('positive feedback') ||
    lower.includes('terse task-oriented')
  ) {
    // Pure descriptive mannerisms have low guidance utility
    behavioral_utility = 0.25;
  } else if (
    lower.includes('year-old') ||
    lower.includes('male') ||
    lower.includes('female') ||
    lower.includes('self-identifies')
  ) {
    behavioral_utility = 0.05;
  } else if (ontology === 'ENVIRONMENT' || ontology === 'PROJECT') {
    behavioral_utility = 0.35;
  } else {
    behavioral_utility = 0.70;
  }

  // 4. Compute Entailment Score and Semantic Strength
  let entailment_score = 0.85;
  let semantic_strength: SemanticStrength = 'moderate-generalization';

  if (supportCount >= 3) {
    entailment_score = 0.95;
    semantic_strength = 'direct';
  } else if (supportCount === 2) {
    entailment_score = 0.88;
    semantic_strength = 'moderate-generalization';
  } else {
    entailment_score = 0.78;
    semantic_strength = 'strong-generalization';
  }

  return {
    behavioral_utility,
    entailment_score,
    semantic_strength,
    trait_role,
    calibratedStatement
  };
}
