export interface ProvenanceRef {
  framework: string;
  session_id: string;
  event_ids: string[];
  project: string | null;
  raw_path?: string;
}

export function createProvenanceRef(
  framework: string,
  sessionId: string,
  eventIds: string[],
  project: string | null,
  rawPath?: string
): ProvenanceRef {
  return {
    framework,
    session_id: sessionId,
    event_ids: eventIds,
    project,
    raw_path: rawPath
  };
}
