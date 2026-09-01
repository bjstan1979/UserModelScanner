import { SessionAdapter, SessionRef } from '../adapters/interface.js';
import { PiAdapter } from '../adapters/pi.js';
import { CodexAdapter } from '../adapters/codex.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { WorkBuddyAdapter } from '../adapters/workbuddy.js';
import { UserModelConfig } from '../config.js';

export interface DiscoveredSessionGroup {
  adapter: SessionAdapter;
  sessions: SessionRef[];
  sourceId: string;
  rootPath: string;
}

export class SessionDiscoverer {
  private adapters: Map<string, SessionAdapter> = new Map();

  constructor() {
    this.registerAdapter(new PiAdapter());
    this.registerAdapter(new CodexAdapter());
    this.registerAdapter(new ClaudeAdapter());
    this.registerAdapter(new OpenCodeAdapter());
    this.registerAdapter(new OpenClawAdapter());
    this.registerAdapter(new WorkBuddyAdapter());
  }

  public registerAdapter(adapter: SessionAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  public getAdapter(name: string): SessionAdapter | undefined {
    return this.adapters.get(name);
  }

  public getAllAdapters(): SessionAdapter[] {
    return Array.from(this.adapters.values());
  }

  public async discoverAll(config: UserModelConfig): Promise<DiscoveredSessionGroup[]> {
    const results: DiscoveredSessionGroup[] = [];

    // If config.sources is explicitly provided, only scan configured sources
    if (config.sources && config.sources.length > 0) {
      for (const sourceConfig of config.sources) {
        if (sourceConfig.enabled === false) continue;
        const adapter = this.adapters.get(sourceConfig.adapter);
        if (!adapter) continue;

        try {
          const sessions = await adapter.discover(sourceConfig.rootPath);
          results.push({
            adapter,
            sessions,
            sourceId: `src_${sourceConfig.id}`,
            rootPath: sourceConfig.rootPath ?? ''
          });
        } catch {
          results.push({
            adapter,
            sessions: [],
            sourceId: `src_${sourceConfig.id}`,
            rootPath: sourceConfig.rootPath ?? ''
          });
        }
      }
      return results;
    }

    // Default: discover all registered adapters
    for (const adapter of this.adapters.values()) {
      try {
        const sessions = await adapter.discover();
        results.push({
          adapter,
          sessions,
          sourceId: `src_${adapter.name}`,
          rootPath: ''
        });
      } catch (err) {
        results.push({
          adapter,
          sessions: [],
          sourceId: `src_${adapter.name}`,
          rootPath: ''
        });
      }
    }

    return results;
  }
}
