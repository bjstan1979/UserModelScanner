import type { CompanionMessage, CompanionSession } from './engine.js';
import type { MemoryOperation } from './schema.js';
import { createDiscourseState, extractCandidatesFromMessage } from './candidate-extractor.js';
import { createResolverState, resolveCandidates } from './resolver.js';

export interface RejectedCandidate {
  item: string;
  reason: string;
  evidenceIds: string[];
}

export interface ExtractionResult {
  operations: MemoryOperation[];
  rejected: RejectedCandidate[];
}

/**
 * Legacy single-message facade. New code should use CompanionScannerEngine so
 * discourse state, entity identity and source-grounding survive across messages.
 */
export function extractMessage(
  message: CompanionMessage,
  sessionDate: string,
  _priorOperations: MemoryOperation[] = []
): ExtractionResult {
  const session: CompanionSession = {
    session_id: `legacy-${message.id}`,
    date: sessionDate,
    topic: 'legacy-single-message',
    messages: [message]
  };
  const extraction = extractCandidatesFromMessage(message, session, createDiscourseState());
  const resolution = resolveCandidates(extraction.candidates, createResolverState());
  return {
    operations: resolution.operations,
    rejected: [...extraction.rejected, ...resolution.rejected]
  };
}
