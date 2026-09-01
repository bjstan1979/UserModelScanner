import { SQLiteStorage } from '../storage/sqlite.js';

export interface StorageBackend {
  name: string;
  isAvailable(): Promise<boolean>;
}

export class LocalMemoryBackend implements StorageBackend {
  readonly name = 'sqlite';

  constructor(private storage: SQLiteStorage) {}

  public async isAvailable(): Promise<boolean> {
    return true;
  }
}
