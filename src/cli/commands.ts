import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, UserModelConfig } from '../config.js';
import { SQLiteStorage } from '../storage/sqlite.js';
import { ScannerEngine, ScanResult } from '../scan/incremental.js';
import { SessionDiscoverer } from '../scan/discover.js';
import { Trait, TraitStatus } from '../traits/schema.js';
import { writeAllUserModelArtifacts } from '../render/user-md.js';
import { writeUserModelJson } from '../render/json.js';
import { createSemanticProvider } from '../semantic/factory.js';
import { COMPANION_PROJECTION_VERSION, CompanionScannerEngine, CompanionSession, companionSessionsFromCanonicalEvents } from '../companion/engine.js';
import { writeAllCompanionArtifacts } from '../companion/renderer.js';
import { IndependentCompanionEvaluator } from '../companion/evaluator.js';
import { loadMiniMaxResponderConfig } from '../companion/minimax-responder.js';
import { MINIMAX_DISCOVERY_CACHE_VERSION, MiniMaxCompanionSemanticProvider } from '../companion/minimax-semantic-provider.js';
import { HybridCompanionSemanticProvider } from '../companion/hybrid-semantic-provider.js';
import { ingestConfiguredSessions } from '../scan/ingest.js';
import { generateLongitudinalCompanionCorpus, type LongitudinalCorpusManifest } from '../simulation/companion-longitudinal.js';
import { evaluateLongitudinalCompanionCorpus } from '../companion/longitudinal-evaluator.js';
import type { FullCompanionSnapshot } from '../companion/schema.js';

export class CliController {
  private config: UserModelConfig;
  private storage: SQLiteStorage;

  constructor(customHome?: string) {
    this.config = loadConfig(customHome);
    this.storage = new SQLiteStorage(this.config.sqlitePath);
  }

  public async scan(options: { full?: boolean; provider?: string } = {}): Promise<ScanResult> {
    const provider = createSemanticProvider(this.config, options.provider);
    console.log(`Starting ${options.full ? 'FULL' : 'INCREMENTAL'} scan...`);
    console.log(`Storage:  ${this.config.sqlitePath}`);
    console.log(`Provider: ${provider.name} (available: ${await provider.isAvailable()})`);

    const engine = new ScannerEngine(this.config, this.storage, provider);
    const result = await engine.scan({ full: options.full });

    console.log('\nScan completed successfully:');
    console.log(`  Run ID:              ${result.runId}`);
    console.log(`  Mode:                ${result.mode}`);
    console.log(`  Provider:            ${result.providerName}`);
    console.log(`  Sessions Discovered: ${result.sessionsDiscovered}`);
    console.log(`  Sessions Processed:  ${result.sessionsProcessed}`);
    console.log(`  Sessions Skipped:    ${result.sessionsSkipped}`);
    console.log(`  Evidence Extracted:  ${result.evidenceExtracted}`);
    console.log(`  Traits Created:      ${result.traitsCreated}`);
    console.log(`  Traits Updated:      ${result.traitsUpdated}`);
    console.log(`  Traits Disputed:     ${result.traitsDisputed}`);
    console.log(`  Traits Scope-Split:  ${result.traitsScopeSplit}`);
    console.log(`  Traits Retired:      ${result.traitsRetired}`);
    console.log(`  Total Active Traits: ${result.totalTraits}`);
    console.log(`  Duration:            ${result.durationMs}ms`);
    console.log(`\nOutputs generated:`);
    console.log(`  USER.md:         ${this.config.userMdPath}`);
    console.log(`  user-model.json: ${this.config.userJsonPath}`);

    return result;
  }

  private async runLongitudinalCompanionScan(options: { source: string; adapter?: string; provider?: string; modelConfig?: string; full?: boolean }): Promise<void> {
    const adapter = options.adapter ?? 'openclaw';
    const supported = ['pi', 'codex', 'claude', 'opencode', 'openclaw', 'workbuddy'] as const;
    if (!supported.includes(adapter as typeof supported[number])) throw new Error(`Unsupported companion source adapter: ${adapter}`);
    const sourceRoot = path.resolve(options.source);
    const existingSource = this.storage.getSource('src_companion');
    if (existingSource?.root_path && path.resolve(existingSource.root_path) !== sourceRoot) {
      throw new Error(`This home already tracks a different companion source: ${existingSource.root_path}`);
    }
    const truthPath = path.join(sourceRoot, 'truth-ledger.json');
    const manifest = fs.existsSync(truthPath)
      ? JSON.parse(fs.readFileSync(truthPath, 'utf8')) as LongitudinalCorpusManifest
      : undefined;
    const simulatedUsers = new Set(manifest?.users.map(user => user.userId) ?? []);
    const companionConfig: UserModelConfig = {
      ...this.config,
      sources: [{ id: 'companion', adapter: adapter as typeof supported[number], rootPath: sourceRoot }]
    };
    const ingestion = await ingestConfiguredSessions(companionConfig, this.storage, { full: options.full, persistCanonicalEvents: true });
    const sessions = companionSessionsFromCanonicalEvents(this.storage.getCanonicalEventsBySource('src_companion'));
    if (sessions.length === 0) throw new Error(`No companion sessions found under ${options.source}`);

    const semanticConfig = ['rule', 'deterministic', 'rule-based'].includes(options.provider ?? '')
      ? undefined
      : loadMiniMaxResponderConfig(options.modelConfig ?? process.env.COMPANION_MODEL_CONFIG);
    const semantic = semanticConfig ? new MiniMaxCompanionSemanticProvider(
      semanticConfig,
      undefined,
      path.join(this.config.homeDir, 'companion', 'semantic-cache', MINIMAX_DISCOVERY_CACHE_VERSION, semanticConfig.model.replace(/[^a-z0-9._-]/gi, '_'))
    ) : undefined;
    const provider = semantic ? new HybridCompanionSemanticProvider(semantic) : undefined;
    const providerName = provider?.name ?? 'companion-rule-based';
    const indexPath = path.join(this.config.homeDir, 'companion', 'longitudinal-index.json');
    const previousIndex = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { provider?: string; projectionVersion?: string }
      : undefined;
    const historyChanged = ingestion.sessions.some(session => !session.isNew);
    const canReuseSnapshots = !options.full && !historyChanged
      && previousIndex?.provider === providerName
      && previousIndex.projectionVersion === COMPANION_PROJECTION_VERSION;
    const newSessions = companionSessionsFromCanonicalEvents(ingestion.sessions.flatMap(session => session.events));
    const userIdFor = (session: CompanionSession) => manifest && simulatedUsers.has(session.topic) ? session.topic : 'default';
    const groups = new Map<string, CompanionSession[]>();
    for (const session of sessions) {
      const userId = userIdFor(session);
      groups.set(userId, [...(groups.get(userId) ?? []), session]);
    }
    const companionRoot = path.join(this.config.homeDir, 'companion');
    const outputRoot = path.join(companionRoot, 'users');
    const singleDefaultUser = groups.size === 1 && groups.has('default');
    const plans = [...groups.entries()].map(([userId, userSessions]) => {
      const outputDir = singleDefaultUser ? companionRoot : path.join(outputRoot, userId);
      const snapshotPath = path.join(outputDir, 'companion-model.json');
      const cached = canReuseSnapshots && fs.existsSync(snapshotPath)
        ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as FullCompanionSnapshot
        : undefined;
      const sessionsToScan = cached ? newSessions.filter(session => userIdFor(session) === userId) : userSessions;
      return { userId, userSessions, outputDir, cached, sessionsToScan };
    });

    const users: Array<{ userId: string; sessions: number; messages: number; outputDir: string }> = [];
    const snapshots = new Map<string, FullCompanionSnapshot>();
    let reusedUsers = 0;
    for (const plan of plans) {
      const snapshot = plan.cached && plan.sessionsToScan.length === 0
        ? plan.cached
        : provider
          ? await new CompanionScannerEngine(provider, plan.cached).scanCompanionDatasetAsync(plan.sessionsToScan)
          : new CompanionScannerEngine(undefined, plan.cached).scanCompanionDataset(plan.sessionsToScan);
      if (plan.cached) reusedUsers += 1;
      if (!plan.cached || plan.sessionsToScan.length > 0) writeAllCompanionArtifacts(plan.outputDir, snapshot);
      snapshots.set(plan.userId, snapshot);
      users.push({
        userId: plan.userId,
        sessions: plan.userSessions.length,
        messages: plan.userSessions.reduce((sum, session) => sum + session.messages.length, 0),
        outputDir: plan.outputDir
      });
    }

    fs.writeFileSync(indexPath, `${JSON.stringify({
      source: sourceRoot,
      adapter,
      provider: providerName,
      projectionVersion: COMPANION_PROJECTION_VERSION,
      ingestion: {
        sessionsDiscovered: ingestion.sessionsDiscovered,
        sessionsProcessed: ingestion.sessionsProcessed,
        sessionsSkipped: ingestion.sessionsSkipped
      },
      projection: {
        reusedUsers,
        scannedSessions: plans.reduce((sum, plan) => sum + plan.sessionsToScan.length, 0)
      },
      semanticUsage: semantic?.usage(),
      routingUsage: provider?.routingUsage(),
      users
    }, null, 2)}\n`);
    console.log(`Longitudinal companion scan: ${users.length} users, ${sessions.length} sessions; ingested=${ingestion.sessionsProcessed}, skipped=${ingestion.sessionsSkipped}, projected=${plans.reduce((sum, plan) => sum + plan.sessionsToScan.length, 0)}`);
    console.log(`Models: ${singleDefaultUser ? companionRoot : outputRoot}`);
    console.log(`Index: ${indexPath}`);

    if (manifest) {
      const report: Record<string, unknown> = { provider: providerName, semantic_usage: semantic?.usage(), routing_usage: provider?.routingUsage(), ...evaluateLongitudinalCompanionCorpus(manifest, snapshots) };
      const reportPath = path.join(this.config.homeDir, 'companion', 'longitudinal-baseline.json');
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`Baseline: ${reportPath} ${JSON.stringify(report.summary)}`);
    }
  }

  public generateCompanionSimulation(outputDir: string): void {
    const manifest = generateLongitudinalCompanionCorpus(path.resolve(outputDir));
    console.log(`Generated ${manifest.generatedSessionCount} sessions / ${manifest.generatedMessageCount} messages for ${manifest.users.length} users at ${path.resolve(outputDir)}`);
  }

  public async runCompanionScan(options: { provider?: string; modelConfig?: string; source?: string; adapter?: string; full?: boolean } = {}): Promise<void> {
    console.log('================================================================');
    console.log('    Running Emotional Companionship AI User Modeling Scan      ');
    console.log('================================================================');

    if (options.source) {
      await this.runLongitudinalCompanionScan({ ...options, source: options.source });
      return;
    }
    const sessionsPath = path.join(process.cwd(), 'companion_sessions.json');
    if (!fs.existsSync(sessionsPath)) {
      console.error('companion_sessions.json not found in current directory');
      return;
    }

    const raw = fs.readFileSync(sessionsPath, 'utf-8');
    const sessions: CompanionSession[] = JSON.parse(raw);
    const messageCount = sessions.reduce((sum, session) => sum + session.messages.length, 0);
    const dates = sessions.map(session => session.date).filter(Boolean).sort();
    console.log(`Loaded ${sessions.length} sessions (${messageCount} messages${dates.length ? ` covering ${dates[0]} to ${dates.at(-1)}` : ''}).`);

    // 1. Original scanner flow: deterministic gate, semantic extraction, offline fallback/governance.
    const semanticConfig = ['rule', 'deterministic', 'rule-based'].includes(options.provider ?? '')
      ? undefined
      : loadMiniMaxResponderConfig(options.modelConfig ?? process.env.COMPANION_MODEL_CONFIG);
    const provider = semanticConfig
      ? new HybridCompanionSemanticProvider(new MiniMaxCompanionSemanticProvider(
        semanticConfig,
        undefined,
        path.join(this.config.homeDir, 'companion', 'semantic-cache', MINIMAX_DISCOVERY_CACHE_VERSION, semanticConfig.model.replace(/[^a-z0-9._-]/gi, '_'))
      ))
      : undefined;
    const engine = new CompanionScannerEngine(provider);
    console.log(`Provider: ${provider?.name ?? 'companion-rule-based'}`);
    const snapshot = provider
      ? await engine.scanCompanionDatasetAsync(sessions)
      : engine.scanCompanionDataset(sessions);

    // 2. Render 5-Layer Artifacts
    const outDir = path.join(this.config.homeDir, 'companion');
    writeAllCompanionArtifacts(outDir, snapshot);

    console.log('\n[SUCCESS] Companion 5-Layer Model Artifacts Generated:');
    console.log(`  1. USER_MODEL.md:         ${path.join(outDir, 'USER_MODEL.md')}`);
    console.log(`  2. RELATIONSHIP.md:       ${path.join(outDir, 'RELATIONSHIP.md')}`);
    console.log(`  3. COMPANION_IDENTITY.md: ${path.join(outDir, 'COMPANION_IDENTITY.md')}`);
    console.log(`  4. EPISODIC_MEMORY.md:    ${path.join(outDir, 'EPISODIC_MEMORY.md')}`);
    console.log(`  5. CURRENT_CONTEXT.md:    ${path.join(outDir, 'CURRENT_CONTEXT.md')}`);
    console.log(`  6. companion-model.json:  ${path.join(outDir, 'companion-model.json')}`);

    // 3. Independent Evaluation against Ground Truth
    console.log('\n================================================================');
    console.log('       Independent Benchmark Evaluation & Probe Testing         ');
    console.log('================================================================');

    const evaluator = new IndependentCompanionEvaluator();
    const evalReport = await evaluator.evaluateSnapshot(snapshot, sessions, null);

    const pct = (value: number | null) => value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
    const printSummary = (label: string, summary: typeof evalReport.canonical_summary) => {
      console.log(`  ${label}: TP=${summary.true_positives}, TN=${summary.true_negatives}, FP=${summary.false_positives}, FN=${summary.false_negatives}, NE=${summary.not_evaluated}, P=${pct(summary.precision)}, R=${pct(summary.recall)}, F1=${pct(summary.f1_score)}, Specificity=${pct(summary.specificity)}`);
    };
    console.log(`Evaluation status: ${evalReport.evaluation_status.toUpperCase()}`);
    console.log(`Overall integration verdict: ${evalReport.overall_pass ? 'PASS' : 'NOT PASSED'}`);
    printSummary('Canonical atomic facts', evalReport.canonical_summary);
    printSummary('Message operations', evalReport.message_expectations_summary);
    printSummary('Message final-state effects', evalReport.message_final_state_summary);
    printSummary('Unsupported output', evalReport.unsupported_output_summary);
    printSummary('Forbidden guards', evalReport.forbidden_summary);
    printSummary('Combined', evalReport.combined_summary);
    console.log(`Probe evaluation kind: ${evalReport.probe_evaluation_kind}`);
    console.log(`Failures: ${evalReport.failed_items.length}; NOT_EVALUATED: ${evalReport.not_evaluated_items.length}`);
    if (evalReport.failed_items.length > 0) {
      console.log('\n--- Failed Structured Assertions ---');
      for (const failure of evalReport.failed_items) {
        console.log(`[${failure.status}] ${failure.gtId}/${failure.assertionId}`);
        console.log(`  expected=${JSON.stringify(failure.expected)}`);
        console.log(`  actual=${JSON.stringify(failure.actual)}`);
        console.log(`  evidence=${failure.evidenceIds.join(',') || 'none'}`);
        console.log(`  reason=${failure.reason}`);
      }
    }
    if (evalReport.not_evaluated_items.length > 0) {
      console.log('\n--- NOT_EVALUATED Structured Assertions ---');
      for (const item of evalReport.not_evaluated_items) {
        console.log(`[NOT_EVALUATED] ${item.gtId}/${item.assertionId}: ${item.reason}`);
      }
    }
    console.log('\n--- Standard 8 Probes Execution (Section 9.1) ---');
    for (const pr of evalReport.probe_results) {
      console.log(`\n[${pr.status}] ${pr.probe_id} · ${pr.type}`);
      console.log(`  User Query: "${pr.query}"`);
      if (pr.status === 'NOT_RUN') {
        console.log(`  Status: NOT_RUN (${pr.reason})`);
      } else {
        console.log(`  Response:\n${pr.response}`);
        console.log(`  Evaluation: ${pr.notes}`);
      }
    }
  }

  public async runABBenchmark(): Promise<void> {
    console.log('================================================================');
    console.log('         Running User Model Scanner A/B Benchmark               ');
    console.log('================================================================');

    const homeA = path.join(this.config.homeDir, 'benchmark-A-deterministic');
    const homeB = path.join(this.config.homeDir, 'benchmark-B-semantic');

    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });

    // Run A
    console.log('\n>>> Running Mode A (Deterministic / Rule-based only)...');
    const configA = loadConfig(homeA);
    configA.sources = this.config.sources;
    const storageA = new SQLiteStorage(configA.sqlitePath);
    const engineA = new ScannerEngine(configA, storageA, 'rule');
    const resA = await engineA.scan({ full: true });
    const traitsA = storageA.getAllTraits();
    const userMdA = fs.existsSync(configA.userMdPath) ? fs.readFileSync(configA.userMdPath, 'utf-8') : '';

    // Run B
    console.log('\n>>> Running Mode B (Deterministic + MiniMax-M3 Semantic Layer)...');
    const configB = loadConfig(homeB);
    configB.sources = this.config.sources;
    const storageB = new SQLiteStorage(configB.sqlitePath);
    const engineB = new ScannerEngine(configB, storageB, 'minimax');
    const resB = await engineB.scan({ full: true });
    const traitsB = storageB.getAllTraits();
    const userMdB = fs.existsSync(configB.userMdPath) ? fs.readFileSync(configB.userMdPath, 'utf-8') : '';

    console.log('\n================================================================');
    console.log('                     A/B BENCHMARK RESULTS                      ');
    console.log('================================================================');
    console.log(`Metric                     | Mode A (Deterministic) | Mode B (Semantic)`);
    console.log(`---------------------------+------------------------+------------------`);
    console.log(`Provider                   | ${resA.providerName.padEnd(22)} | ${resB.providerName.padEnd(16)}`);
    console.log(`Sessions Processed         | ${String(resA.sessionsProcessed).padEnd(22)} | ${String(resB.sessionsProcessed).padEnd(16)}`);
    console.log(`Evidence Extracted         | ${String(resA.evidenceExtracted).padEnd(22)} | ${String(resB.evidenceExtracted).padEnd(16)}`);
    console.log(`Total Traits               | ${String(traitsA.length).padEnd(22)} | ${String(traitsB.length).padEnd(16)}`);
    console.log(`Stable Traits              | ${String(traitsA.filter(t => t.status === 'stable').length).padEnd(22)} | ${String(traitsB.filter(t => t.status === 'stable').length).padEnd(16)}`);
    console.log(`Working Traits             | ${String(traitsA.filter(t => t.status === 'working').length).padEnd(22)} | ${String(traitsB.filter(t => t.status === 'working').length).padEnd(16)}`);
    console.log(`Candidate Traits           | ${String(traitsA.filter(t => t.status === 'candidate').length).padEnd(22)} | ${String(traitsB.filter(t => t.status === 'candidate').length).padEnd(16)}`);
    console.log(`Duration (ms)              | ${String(resA.durationMs).padEnd(22)} | ${String(resB.durationMs).padEnd(16)}`);

    console.log('\n--- Mode A USER.md ---');
    console.log(userMdA.trim());

    console.log('\n--- Mode B USER.md ---');
    console.log(userMdB.trim());

    storageA.close();
    storageB.close();
  }

  public status(): void {
    const runs = this.storage.getScanRuns(5);
    const sessions = this.storage.getAllSessions();
    const traits = this.storage.getAllTraits();
    const evidence = this.storage.getAllEvidenceEvents();

    console.log('=== User Model Scanner Status ===');
    console.log(`Home Directory: ${this.config.homeDir}`);
    console.log(`SQLite Path:    ${this.config.sqlitePath}`);
    console.log(`Total Sessions Processed: ${sessions.length}`);
    console.log(`Total Evidence Events:    ${evidence.length}`);
    console.log(`Total Traits:             ${traits.length}`);

    const statusCounts: Record<string, number> = {};
    for (const t of traits) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }
    console.log(`Trait Statuses: ` + Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(', '));

    console.log('\nRecent Scan Runs:');
    if (runs.length === 0) {
      console.log('  (No scan runs recorded yet)');
    } else {
      for (const r of runs) {
        console.log(`  - [${r.started_at}] (${r.mode}) ${r.id}`);
      }
    }
  }

  public show(): void {
    if (fs.existsSync(this.config.userMdPath)) {
      const content = fs.readFileSync(this.config.userMdPath, 'utf-8');
      console.log(content);
    } else {
      console.log(`No USER.md found at ${this.config.userMdPath}. Run 'user-model scan' first.`);
    }
  }

  public traits(): void {
    const traits = this.storage.getAllTraits();
    if (traits.length === 0) {
      console.log('No traits found. Run "user-model scan" first.');
      return;
    }

    console.log('\n=== User Traits ===');
    console.log('ID'.padEnd(16) + 'Category'.padEnd(20) + 'Status'.padEnd(10) + 'Conf'.padEnd(6) + 'Sessions'.padEnd(10) + 'Statement');
    console.log('-'.repeat(100));

    for (const t of traits) {
      console.log(
        t.id.padEnd(16) +
        t.category.padEnd(20) +
        t.status.padEnd(10) +
        t.confidence.toFixed(2).padEnd(6) +
        String(t.distinct_sessions).padEnd(10) +
        t.statement
      );
    }
  }

  public evidence(traitId: string): void {
    const trait = this.storage.getTrait(traitId);
    if (!trait) {
      console.error(`Trait not found: ${traitId}`);
      return;
    }

    const evidenceList = this.storage.getEvidenceForTrait(traitId);
    console.log(`\n=== Evidence for Trait: ${trait.id} ===`);
    console.log(`Statement:  ${trait.statement}`);
    console.log(`Category:   ${trait.category}`);
    console.log(`Status:     ${trait.status} (confidence: ${trait.confidence})`);
    console.log(`Total Linked Evidence: ${evidenceList.length}\n`);

    for (const ev of evidenceList) {
      console.log(`[${ev.relation.toUpperCase()}] ID: ${ev.id} | Signal: ${ev.signal_type} | Strength: ${ev.strength}`);
      console.log(`  Statement: ${ev.statement}`);
      console.log(`  Session:   ${ev.source_session_id}`);
      console.log(`  Context:   ${ev.context_json}`);
      console.log(`  Timestamp: ${ev.timestamp}`);
      console.log('');
    }
  }

  public correct(traitId: string, newStatement?: string): void {
    const traitRow = this.storage.getTrait(traitId);
    if (!traitRow) {
      console.error(`Trait not found: ${traitId}`);
      return;
    }

    const statement = newStatement || traitRow.statement;
    const oldJson = JSON.stringify(traitRow);

    const updatedRow = {
      ...traitRow,
      statement,
      status: 'stable' as const,
      confidence: 1.0,
      last_confirmed: new Date().toISOString()
    };

    this.storage.upsertTrait(updatedRow);
    this.storage.recordTraitHistory({
      trait_id: traitId,
      old_json: oldJson,
      new_json: JSON.stringify(updatedRow),
      reason: 'User manual correction via CLI',
      changed_at: new Date().toISOString()
    });

    this.syncOutputs();
    console.log(`Successfully corrected trait ${traitId}. Status set to 'stable' (conf: 1.0).`);
  }

  public forget(traitId: string): void {
    const traitRow = this.storage.getTrait(traitId);
    if (!traitRow) {
      console.error(`Trait not found: ${traitId}`);
      return;
    }

    const oldJson = JSON.stringify(traitRow);
    const retiredRow = {
      ...traitRow,
      status: 'retired' as const,
      confidence: 0.0,
      last_confirmed: new Date().toISOString()
    };

    this.storage.upsertTrait(retiredRow);
    this.storage.recordTraitHistory({
      trait_id: traitId,
      old_json: oldJson,
      new_json: JSON.stringify(retiredRow),
      reason: 'User manual forget via CLI',
      changed_at: new Date().toISOString()
    });

    this.syncOutputs();
    console.log(`Successfully retired trait ${traitId}. Excluded from active USER.md.`);
  }

  public diff(): void {
    const history = this.storage.getTraitHistory();
    if (history.length === 0) {
      console.log('No model history recorded yet.');
      return;
    }

    console.log('\n=== Recent User Model Diffs ===');
    for (const h of history.slice(0, 10)) {
      console.log(`[${h.changed_at}] Trait: ${h.trait_id} | Reason: ${h.reason}`);
      if (h.old_json && h.new_json) {
        try {
          const oldT = JSON.parse(h.old_json);
          const newT = JSON.parse(h.new_json);
          console.log(`  - Old: status=${oldT.status}, conf=${oldT.confidence}, stmt="${oldT.statement}"`);
          console.log(`  + New: status=${newT.status}, conf=${newT.confidence}, stmt="${newT.statement}"`);
        } catch {}
      } else if (h.new_json) {
        try {
          const newT = JSON.parse(h.new_json);
          console.log(`  + Created: status=${newT.status}, conf=${newT.confidence}, stmt="${newT.statement}"`);
        } catch {}
      }
      console.log('');
    }
  }

  public async sources(): Promise<void> {
    const discoverer = new SessionDiscoverer();
    const groups = await discoverer.discoverAll(this.config);

    console.log('\n=== Registered Sources & Adapters ===');
    for (const g of groups) {
      const sourceId = `src_${g.adapter.name}`;
      const srcRecord = this.storage.getSource(sourceId);
      console.log(`Adapter: [${g.adapter.name.toUpperCase()}]`);
      console.log(`  Sessions Discovered: ${g.sessions.length}`);
      console.log(`  Last Scan At:        ${srcRecord?.last_scan_at || 'Never'}`);
    }
  }

  private syncOutputs(): void {
    const allTraits: Trait[] = this.storage.getAllTraits().map(r => {
      const evList = this.storage.getEvidenceForTrait(r.id);
      return {
        id: r.id,
        category: r.category as any,
        ontology: (r.ontology as any) || 'USER_GLOBAL',
        statement: r.statement,
        scope: r.scope,
        domain: r.domain,
        tool: r.tool,
        environment: r.environment,
        project_id: r.project_id,
        status: r.status as TraitStatus,
        confidence: r.confidence,
        portability_score: r.portability_score ?? 0.5,
        behavioral_utility: r.behavioral_utility ?? 0.5,
        entailment_score: r.entailment_score ?? 0.8,
        semantic_strength: r.semantic_strength || 'moderate-generalization',
        trait_role: r.trait_role || 'ACTION_GUIDANCE',
        support_count: r.support_count,
        contradiction_count: r.contradiction_count,
        distinct_sessions: r.distinct_sessions,
        distinct_contexts: r.distinct_contexts,
        first_seen: r.first_seen,
        last_confirmed: r.last_confirmed,
        evidence_ids: evList.map(e => e.id)
      };
    });

    writeAllUserModelArtifacts(this.config, allTraits);
    writeUserModelJson(this.config.userJsonPath, allTraits, this.config.extractorVersion);
  }

  public close(): void {
    this.storage.close();
  }
}
