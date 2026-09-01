import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface UserModelConfig {
  homeDir: string;
  sqlitePath: string;
  userMdPath: string;
  domainsMdPath: string;
  toolsMdPath: string;
  environmentMdPath: string;
  projectsDir: string;
  userJsonPath: string;
  extractorVersion: string;
  tokenCap: number; // Token budget cap for USER.md (500 - 1500)
  sources?: Array<{
    id: string;
    adapter: 'pi' | 'codex' | 'claude' | 'opencode' | 'openclaw' | 'workbuddy';
    rootPath?: string;
    enabled?: boolean;
  }>;
  hindsight?: {
    enabled: boolean;
    endpoint?: string;
    apiKey?: string;
  };
  semanticProvider?: {
    type: 'rule' | 'openai' | 'minimax' | 'anthropic';
    endpoint?: string;
    apiKey?: string;
    model?: string;
  };
}

export function getDefaultHomeDir(): string {
  if (process.env.USER_MODEL_HOME) {
    return path.resolve(process.env.USER_MODEL_HOME);
  }
  return path.join(os.homedir(), '.user-model');
}

export function loadConfig(customHome?: string): UserModelConfig {
  const homeDir = customHome ? path.resolve(customHome) : getDefaultHomeDir();
  const configFilePath = path.join(homeDir, 'config.json');

  let fileConfig: Partial<UserModelConfig> = {};
  if (fs.existsSync(configFilePath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch {
      // ignore config read errors, use defaults
    }
  }

  return {
    homeDir,
    sqlitePath: path.join(homeDir, 'evidence.sqlite'),
    userMdPath: path.join(homeDir, 'USER.md'),
    domainsMdPath: path.join(homeDir, 'DOMAINS.md'),
    toolsMdPath: path.join(homeDir, 'TOOLS.md'),
    environmentMdPath: path.join(homeDir, 'ENVIRONMENT.md'),
    projectsDir: path.join(homeDir, 'PROJECTS'),
    userJsonPath: path.join(homeDir, 'user-model.json'),
    extractorVersion: '2.0.0',
    tokenCap: 1500,
    ...fileConfig,
  };
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
