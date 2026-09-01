import { StorageBackend } from './memory.js';

export interface HindsightConfig {
  enabled: boolean;
  endpoint?: string;
  apiKey?: string;
}

export class HindsightBackend implements StorageBackend {
  readonly name = 'hindsight';

  constructor(private config?: HindsightConfig) {}

  public async isAvailable(): Promise<boolean> {
    if (!this.config?.enabled) return false;
    return Boolean(this.config.endpoint || process.env.HINDSIGHT_ENDPOINT || process.env.HINDSIGHT_API_KEY);
  }

  public async retainObservation(sessionId: string, text: string, tags: string[] = []): Promise<boolean> {
    const available = await this.isAvailable();
    if (!available) return false;
    // When hindsight is configured, call retain API
    return true;
  }

  public async recallContext(query: string, limit = 5): Promise<string[]> {
    const available = await this.isAvailable();
    if (!available) return [];
    // When hindsight is configured, call recall API
    return [];
  }
}
