import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticProvider } from './interface.js';
import { RuleBasedProvider } from './rule-based.js';
import { OpenAICompatibleProvider, OpenAICompatibleConfig } from './openai-compatible.js';
import { UserModelConfig } from '../config.js';

export function createSemanticProvider(
  config: UserModelConfig,
  requestedType?: string
): SemanticProvider {
  // 1. Explicit request for rule-based
  if (requestedType === 'rule' || requestedType === 'deterministic' || requestedType === 'rule-based') {
    return new RuleBasedProvider();
  }

  // 2. Check config or requestedType
  let providerConfig: OpenAICompatibleConfig | undefined;

  if (config.semanticProvider && config.semanticProvider.type !== 'rule') {
    providerConfig = {
      endpoint: config.semanticProvider.endpoint,
      apiKey: config.semanticProvider.apiKey,
      model: config.semanticProvider.model
    };
  }

  // 3. Auto-detect from ~/.openclaw/workspace-doctor/minimal-agent/minimax.md
  if (!providerConfig?.apiKey) {
    const minimaxMdPath = path.join(os.homedir(), '.openclaw', 'workspace-doctor', 'minimal-agent', 'minimax.md');
    if (fs.existsSync(minimaxMdPath)) {
      try {
        const text = fs.readFileSync(minimaxMdPath, 'utf-8');
        const apiMatch = text.match(/api:\s*([^\s\n]+)/i);
        const urlMatch = text.match(/url:\s*([^\s\n]+)/i);
        const modelMatch = text.match(/model:\s*([^\s\n]+)/i);

        if (apiMatch) {
          providerConfig = {
            apiKey: apiMatch[1].trim(),
            endpoint: urlMatch ? urlMatch[1].trim() : 'https://api.minimaxi.com/v1',
            model: modelMatch ? modelMatch[1].trim() : 'MiniMax-M3'
          };
        }
      } catch {}
    }
  }

  // 4. Check environment variables
  if (!providerConfig?.apiKey && (process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY)) {
    providerConfig = {
      apiKey: process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY,
      endpoint: process.env.OPENAI_BASE_URL || 'https://api.minimaxi.com/v1',
      model: process.env.USER_MODEL_LLM || 'MiniMax-M3'
    };
  }

  if (providerConfig && providerConfig.apiKey) {
    return new OpenAICompatibleProvider(providerConfig);
  }

  // Default fallback to rule-based
  return new RuleBasedProvider();
}
