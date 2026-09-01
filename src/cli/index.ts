#!/usr/bin/env node
import { Command } from 'commander';
import { CliController } from './commands.js';

const program = new Command();

program
  .name('user-model')
  .description('Independent cross-framework User Model Scanner (Pi, Codex, WorkBuddy, Claude, OpenCode, OpenClaw)')
  .version('2.0.0')
  .option('--home <path>', 'Custom user-model home directory');

program
  .command('scan')
  .description('Run incremental session scan (or full with --full)')
  .option('--full', 'Force full rescan of all historical sessions')
  .option('--provider <type>', 'Semantic provider (minimax | openai | rule | deterministic)')
  .option('--ab', 'Run A/B benchmark (A: deterministic vs B: semantic provider)')
  .action(async (options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      if (options.ab) {
        await controller.runABBenchmark();
      } else {
        await controller.scan({ full: options.full, provider: options.provider });
      }
    } finally {
      controller.close();
    }
  });

program
  .command('companion')
  .description('Run Emotional Companionship AI 5-Layer User Modeling benchmark & query probes')
  .option('--provider <type>', 'Semantic provider (auto | rule | deterministic)', 'auto')
  .option('--model-config <path>', 'OpenAI-compatible model config markdown path')
  .option('--source <path>', 'Scan longitudinal sessions through a shared adapter source')
  .option('--adapter <name>', 'Session adapter for --source', 'openclaw')
  .option('--full', 'Force full companion source re-ingestion')
  .action(async (options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      await controller.runCompanionScan({ provider: options.provider, modelConfig: options.modelConfig, source: options.source, adapter: options.adapter, full: options.full });
    } finally {
      controller.close();
    }
  });

program
  .command('companion-simulate')
  .description('Generate a deterministic multi-user longitudinal companion corpus')
  .requiredOption('--out <path>', 'Empty output directory for OpenClaw JSONL sessions and truth ledger')
  .action((options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.generateCompanionSimulation(options.out);
    } finally {
      controller.close();
    }
  });
program
  .command('status')
  .description('Show scanner status, session counts, and trait statistics')
  .action((options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.status();
    } finally {
      controller.close();
    }
  });

program
  .command('show')
  .description('Print the rendered USER.md model')
  .action((options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.show();
    } finally {
      controller.close();
    }
  });

program
  .command('traits')
  .description('List all structured traits with confidence and session counts')
  .action((options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.traits();
    } finally {
      controller.close();
    }
  });

program
  .command('evidence <trait-id>')
  .description('Inspect supporting and contradicting evidence for a trait')
  .action((traitId, options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.evidence(traitId);
    } finally {
      controller.close();
    }
  });

program
  .command('correct <trait-id> [new-statement]')
  .description('Manually correct or confirm a trait statement')
  .action((traitId, newStatement, options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      const stmt = typeof newStatement === 'string' ? newStatement : undefined;
      controller.correct(traitId, stmt);
    } finally {
      controller.close();
    }
  });

program
  .command('forget <trait-id>')
  .description('Retire/delete a trait from active user model')
  .action((traitId, options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.forget(traitId);
    } finally {
      controller.close();
    }
  });

program
  .command('diff')
  .description('Show recent changes and audit history of traits')
  .action((options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      controller.diff();
    } finally {
      controller.close();
    }
  });

program
  .command('sources')
  .description('Show adapter discovery and source session statuses')
  .action(async (options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const controller = new CliController(opts.home);
    try {
      await controller.sources();
    } finally {
      controller.close();
    }
  });

program.parse(process.argv);
