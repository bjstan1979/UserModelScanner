import {
  canonicalPredicate,
  type CompanionCandidate,
  type CompanionLayer,
  type EntityMention,
  stableCandidateId,
  stableHash
} from './ontology.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scalar(value: unknown, ...keys: string[]): unknown {
  const object = record(value);
  if (!object) return value;
  for (const key of keys) if (object[key] !== undefined) return object[key];
  return value;
}

function personMention(candidate: CompanionCandidate): EntityMention | undefined {
  return candidate.entityMentions.find(mention => mention.entityType === 'person');
}

function entityToken(candidate: CompanionCandidate): string {
  const mention = personMention(candidate) ?? candidate.entityMentions[0];
  if (!mention) return stableHash(candidate.discourseKey ?? candidate.source.text);
  const qualifiers = mention.qualifiers ?? {};
  const discriminator = mention.relation
    ?? qualifiers.organization
    ?? qualifiers.location
    ?? qualifiers.occupation
    ?? '';
  return stableHash(`${mention.entityType}|${mention.surface}|${String(discriminator)}`);
}

function overlapsEntity(left: CompanionCandidate, right: CompanionCandidate): boolean {
  return left.entityMentions.some(a => right.entityMentions.some(b => a.entityType === b.entityType && a.surface === b.surface));
}

function priorCorrection(candidate: CompanionCandidate, predicate: string, prior: CompanionCandidate[]): CompanionCandidate | undefined {
  const explicit = [...prior].reverse().find(item => candidate.correctionTargets.includes(item.subject));
  if (explicit) return explicit;
  if (candidate.modality !== 'corrective' && candidate.temporalStatus !== 'closed' && candidate.correctionTargets.length === 0) return undefined;
  return [...prior].reverse().find(item => canonicalPredicate(item.predicate) === predicate && overlapsEntity(candidate, item));
}

function topicToken(candidate: CompanionCandidate): string {
  const quoted = candidate.source.text.match(/[“"]([^”"]{1,32})[”"]/)?.[1];
  return stableHash(candidate.discourseKey ?? quoted ?? candidate.source.text);
}

function canonicalSubject(candidate: CompanionCandidate, predicate: string, corrected?: CompanionCandidate): string {
  if (corrected) return corrected.subject;
  const person = personMention(candidate);
  switch (predicate) {
    case 'identity.full_name': return 'profile.identity.full_name';
    case 'identity.surname': return 'profile.identity.surname';
    case 'identity.age': return 'profile.identity.age';
    case 'identity.childhood_place': return 'profile.childhood_place.current';
    case 'entity.current_location': return person ? `people.entity.${entityToken(candidate)}` : 'profile.residence.current';
    case 'entity.occupation': return person ? `people.entity.${entityToken(candidate)}` : 'profile.occupation.current';
    case 'entity.relation': return `people.relation.${entityToken(candidate)}`;
    case 'preference.medium': return 'preference.medium.current';
    case 'preference.value': return person ? `people.entity.${entityToken(candidate)}` : `preference.value.${topicToken(candidate)}`;
    case 'decision.plan': return `decision.plan.${topicToken(candidate)}`;
    case 'context.stress_state': return 'context.stress.current';
    case 'context.resolution': return 'context.resolution.current';
    case 'relationship.ordered_protocol': return `relationship.protocol.${topicToken(candidate)}`;
    case 'relationship.ritual': return `relationship.ritual.${topicToken(candidate)}`;
    case 'episode.ritual_occurrence': return `episode.event.${topicToken(candidate)}`;
    case 'event.timeline_step':
    case 'event.ordered_timeline': return `event.timeline.${topicToken(candidate)}`;
    default: return candidate.subject;
  }
}
function canonicalLayer(subject: string, fallback: CompanionLayer): CompanionLayer {
  if (/^(?:profile|people|preference|communication|value)\./.test(subject)) return 'USER_MODEL';
  if (subject.startsWith('relationship.')) return 'RELATIONSHIP';
  if (subject.startsWith('identity.')) return 'COMPANION_IDENTITY';
  if (/^(?:decision|context)\./.test(subject)) return 'CURRENT_CONTEXT';
  if (/^(?:episode|event)\./.test(subject)) return 'EPISODIC_MEMORY';
  return fallback;
}

function canonicalValue(candidate: CompanionCandidate, predicate: string): unknown {
  const value = candidate.value;
  switch (predicate) {
    case 'identity.full_name': return scalar(value, 'fullName', 'full_name', 'name');
    case 'identity.surname': return scalar(value, 'surname');
    case 'identity.age': return scalar(value, 'age');
    case 'identity.childhood_place': return scalar(value, 'childhoodPlace', 'childhood_place', 'place');
    case 'entity.current_location': return scalar(value, 'currentResidence', 'current_location', 'location');
    case 'entity.occupation': return scalar(value, 'occupation');
    case 'preference.medium': return scalar(value, 'longFormMedium', 'preferred_medium', 'medium');
    case 'entity.relation': {
      const object = record(value);
      const mention = personMention(candidate);
      const name = object?.name ?? mention?.surface;
      const relation = object?.relation ?? mention?.relation ?? (typeof value === 'string' ? value : undefined);
      if (!name || !relation) return value;
      return relation;
    }
    default: return value;
  }
}

export function canonicalizeCompanionCandidates(
  candidates: CompanionCandidate[],
  prior: CompanionCandidate[] = []
): CompanionCandidate[] {
  const canonical: CompanionCandidate[] = [];
  for (const [ordinal, candidate] of candidates.entries()) {
    const predicate = canonicalPredicate(candidate.predicate) ?? candidate.predicate;
    const corrected = priorCorrection(candidate, predicate, [...prior, ...canonical]);
    const subject = canonicalSubject(candidate, predicate, corrected);
    canonical.push({
      ...candidate,
      candidateId: stableCandidateId(candidate.source.messageId, subject, predicate, ordinal),
      layer: canonicalLayer(subject, candidate.layer),
      subject,
      predicate,
      value: canonicalValue(candidate, predicate),
      correctionTargets: corrected ? [corrected.subject] : candidate.correctionTargets
    });
  }
  return canonical;
}
