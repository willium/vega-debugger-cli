#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as vega from 'vega';
import { compile as compileVegaLite } from 'vega-lite';

type SpecFormat = 'vega' | 'vega-lite';
type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type OutputMode = 'json' | 'text';

type JsonObject = Record<string, unknown>;

type LogEntry = {
  level: LogLevel;
  message: string;
};

type Issue = {
  source: 'schema' | 'compile' | 'runtime';
  level: 'warning' | 'error';
  message: string;
};

type SchemaValidationResult = {
  attempted: boolean;
  ok: boolean;
  schemaUrl?: string;
  schemaLibrary?: SpecFormat;
  schemaVersion?: string;
  errors?: string[];
  warning?: string;
};

type RuntimeDataSummary = {
  name: string;
  size: number;
  sample: unknown[];
};

type RuntimeSignalSummary = {
  name: string;
  value: unknown;
};

type IssuesBlock = {
  errors: Issue[];
  warnings: Issue[];
  summary?: {
    totalErrors: number;
    totalWarnings: number;
    shownErrors: number;
    shownWarnings: number;
    deduplicated: boolean;
    truncated: boolean;
  };
};

type DebugReport = {
  input: {
    specPath: string;
    format: SpecFormat;
  };
  issues: IssuesBlock;
  schemaValidation: SchemaValidationResult;
  compile: {
    applied: boolean;
    logs: LogEntry[];
  };
  runtime: {
    success: boolean;
    error?: string;
    logs: LogEntry[];
    availableSignals: string[];
    availableData: string[];
    inspectedSignals: RuntimeSignalSummary[];
    inspectedData: RuntimeDataSummary[];
    state?: unknown;
    runtimeSummary?: {
      signalOperators: number;
      dataNodes: number;
      scaleOperators: number;
      subcontextCount: number;
      nodeCount: number;
    };
  };
  compiledSpec?: unknown;
};

type TuningOptions = {
  includeStack: boolean;
  dedupe: boolean;
  maxErrors: number;
  maxWarnings: number;
};

const require = createRequire(import.meta.url);

const HELP_TEXT = `Usage:
  vega-debugger --spec <spec.json> [options]

Options:
  -s, --spec <path>          Path to Vega or Vega-Lite JSON spec.
  -f, --format <type>        Spec type: auto | vega | vega-lite (default: auto).
      --schema-url <url>     Override schema URL used for JSON schema validation.
      --no-validate-schema   Skip schema validation step.
      --signal <name>        Signal name to inspect (repeatable).
      --data <name>          Data set name to inspect (repeatable).
      --set-signal <k=v>     Set signal before run; value parsed as JSON if possible.
      --state                Include view.getState() snapshot.
      --runtime              Include runtime internals summary from view._runtime.
      --log-level <level>    Runtime log level: error | warn | info | debug (default: warn).
      --sample-size <n>      Rows to include in each data sample (default: 5).
      --max-errors <n>       Max errors in output report (default: 12).
      --max-warnings <n>     Max warnings in output report (default: 12).
      --no-dedupe            Disable deduplication of repeated issues.
      --include-stack        Keep full stack traces in error messages.
      --include-schema-errors Include raw schemaValidation.errors in output.
      --only-issues          Emit minimal JSON focused on actionable issues.
      --output <mode>        Output mode: json | text (default: json).
      --print-compiled       Include compiled Vega spec in output report.
  -o, --out <path>           Write output report to a file.
  -h, --help                 Show this message.
`;

async function main(argv: string[]): Promise<number> {
  let parsed;

  try {
    parsed = parseArgs({
      args: argv,
      options: {
        spec: { type: 'string', short: 's' },
        format: { type: 'string', short: 'f', default: 'auto' },
        'schema-url': { type: 'string' },
        'no-validate-schema': { type: 'boolean', default: false },
        signal: { type: 'string', multiple: true },
        data: { type: 'string', multiple: true },
        'set-signal': { type: 'string', multiple: true },
        state: { type: 'boolean', default: false },
        runtime: { type: 'boolean', default: false },
        'log-level': { type: 'string', default: 'warn' },
        'sample-size': { type: 'string', default: '5' },
        'max-errors': { type: 'string', default: '12' },
        'max-warnings': { type: 'string', default: '12' },
        'no-dedupe': { type: 'boolean', default: false },
        'include-stack': { type: 'boolean', default: false },
        'include-schema-errors': { type: 'boolean', default: false },
        'only-issues': { type: 'boolean', default: false },
        output: { type: 'string', default: 'json' },
        'print-compiled': { type: 'boolean', default: false },
        out: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h', default: false }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (err) {
    process.stderr.write(`${toErrorMessage(err, false)}\n\n${HELP_TEXT}`);
    return 1;
  }

  if (parsed.values.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const specPathRaw = parsed.values.spec;
  if (!specPathRaw) {
    process.stderr.write(`Missing required --spec <path>.\n\n${HELP_TEXT}`);
    return 1;
  }

  const formatArg = parsed.values.format;
  if (formatArg !== 'auto' && formatArg !== 'vega' && formatArg !== 'vega-lite') {
    process.stderr.write(`Invalid --format value: ${formatArg}. Use auto, vega, or vega-lite.\n`);
    return 1;
  }

  const logLevel = parsed.values['log-level'];
  if (logLevel !== 'error' && logLevel !== 'warn' && logLevel !== 'info' && logLevel !== 'debug') {
    process.stderr.write('Invalid --log-level. Use error, warn, info, or debug.\n');
    return 1;
  }

  const sampleSize = parseNonNegativeInt(parsed.values['sample-size'], '--sample-size');
  const maxErrors = parseNonNegativeInt(parsed.values['max-errors'], '--max-errors');
  const maxWarnings = parseNonNegativeInt(parsed.values['max-warnings'], '--max-warnings');
  if (sampleSize === undefined || maxErrors === undefined || maxWarnings === undefined) {
    return 1;
  }

  const outputMode = parsed.values.output;
  if (outputMode !== 'json' && outputMode !== 'text') {
    process.stderr.write('Invalid --output. Use json or text.\n');
    return 1;
  }
  const normalizedOutputMode: OutputMode = outputMode;

  const tuning: TuningOptions = {
    includeStack: parsed.values['include-stack'],
    dedupe: !parsed.values['no-dedupe'],
    maxErrors,
    maxWarnings
  };

  const specPath = resolve(specPathRaw);

  let inputSpec: unknown;
  try {
    const text = await readFile(specPath, 'utf8');
    inputSpec = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`Failed to read spec: ${toErrorMessage(err, false)}\n`);
    return 1;
  }

  if (!isObject(inputSpec)) {
    process.stderr.write('Spec must be a JSON object.\n');
    return 1;
  }

  const detectedFormat = detectFormat(inputSpec, formatArg);
  const compileLogs: LogEntry[] = [];

  const schemaValidation = await validateSchema({
    inputSpec,
    schemaOverrideUrl: parsed.values['schema-url'],
    skipValidation: parsed.values['no-validate-schema']
  });

  let vegaSpec: JsonObject;
  if (detectedFormat === 'vega-lite') {
    const vlLogger = {
      level: vega.Warn,
      warn: (...args: unknown[]) => compileLogs.push({ level: 'warn', message: stringifyLog(args) }),
      info: (...args: unknown[]) => compileLogs.push({ level: 'info', message: stringifyLog(args) }),
      debug: (...args: unknown[]) => compileLogs.push({ level: 'debug', message: stringifyLog(args) })
    };

    try {
      const compiled = compileVegaLite(inputSpec as never, { logger: vlLogger as never });
      vegaSpec = compiled.spec as JsonObject;
    } catch (err) {
      const report: DebugReport = {
        input: { specPath, format: detectedFormat },
        issues: { errors: [], warnings: [] },
        schemaValidation,
        compile: {
          applied: true,
          logs: [...compileLogs, { level: 'error', message: toErrorMessage(err, true) }]
        },
        runtime: {
          success: false,
          error: `Vega-Lite compile failed: ${toErrorMessage(err, true)}`,
          logs: [],
          availableSignals: [],
          availableData: [],
          inspectedSignals: [],
          inspectedData: []
        }
      };

      report.issues = collectIssues(report);
      tuneReport(report, tuning);
      await writeReport(
        report,
        parsed.values.out,
        normalizedOutputMode,
        parsed.values['only-issues'],
        parsed.values['include-schema-errors']
      );
      return 2;
    }
  } else {
    vegaSpec = inputSpec;
  }

  const runtime = await runRuntimeDebug({
    vegaSpec,
    logLevel,
    signalNames: parsed.values.signal || [],
    dataNames: parsed.values.data || [],
    setSignals: parsed.values['set-signal'] || [],
    includeState: parsed.values.state,
    includeRuntime: parsed.values.runtime,
    sampleSize
  });

  const report: DebugReport = {
    input: { specPath, format: detectedFormat },
    issues: { errors: [], warnings: [] },
    schemaValidation,
    compile: {
      applied: detectedFormat === 'vega-lite',
      logs: compileLogs
    },
    runtime,
    compiledSpec: parsed.values['print-compiled'] ? vegaSpec : undefined
  };

  report.issues = collectIssues(report);
  tuneReport(report, tuning);
  await writeReport(
    report,
    parsed.values.out,
    normalizedOutputMode,
    parsed.values['only-issues'],
    parsed.values['include-schema-errors']
  );

  return report.runtime.success ? 0 : 2;
}

function parseNonNegativeInt(raw: string, flag: string): number | undefined {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(`Invalid ${flag}. Use a non-negative integer.\n`);
    return undefined;
  }
  return value;
}

function detectFormat(spec: JsonObject, formatArg: 'auto' | SpecFormat): SpecFormat {
  if (formatArg !== 'auto') {
    return formatArg;
  }

  const schema = typeof spec.$schema === 'string' ? spec.$schema.toLowerCase() : '';
  return schema.includes('/vega-lite/') ? 'vega-lite' : 'vega';
}

async function validateSchema(args: {
  inputSpec: JsonObject;
  schemaOverrideUrl?: string;
  skipValidation: boolean;
}): Promise<SchemaValidationResult> {
  const { inputSpec, schemaOverrideUrl, skipValidation } = args;

  if (skipValidation) {
    return { attempted: false, ok: true, warning: 'Skipped (--no-validate-schema).' };
  }

  const schemaUrl = schemaOverrideUrl || (typeof inputSpec.$schema === 'string' ? inputSpec.$schema : undefined);
  if (!schemaUrl) {
    return {
      attempted: false,
      ok: true,
      warning: 'No $schema found; pass --schema-url to validate explicitly.'
    };
  }

  const parsed = parseSchemaUrl(schemaUrl);
  let schemaDoc: unknown;
  let remoteError: string | undefined;

  try {
    const response = await fetch(schemaUrl);
    if (!response.ok) {
      remoteError = `Failed to fetch schema: HTTP ${response.status}`;
    } else {
      schemaDoc = await response.json();
    }
  } catch (err) {
    remoteError = toErrorMessage(err, true);
  }

  let localWarning: string | undefined;
  if (!schemaDoc && parsed) {
    try {
      schemaDoc = await loadLocalSchema(parsed.library);
      if (remoteError) {
        localWarning = `Remote schema fetch failed; validated with local ${parsed.library} schema from installed package.`;
      }
    } catch (localErr) {
      const errors = [remoteError, toErrorMessage(localErr, true)].filter(Boolean) as string[];
      return {
        attempted: true,
        ok: false,
        schemaUrl,
        schemaLibrary: parsed.library,
        schemaVersion: parsed.version,
        errors
      };
    }
  }

  if (!schemaDoc) {
    return {
      attempted: true,
      ok: false,
      schemaUrl,
      schemaLibrary: parsed?.library,
      schemaVersion: parsed?.version,
      errors: [remoteError || 'Unable to load schema.']
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat('color-hex', true);

  const validate = ajv.compile(schemaDoc);
  const valid = validate(inputSpec);

  if (valid) {
    return {
      attempted: true,
      ok: true,
      schemaUrl,
      schemaLibrary: parsed?.library,
      schemaVersion: parsed?.version,
      warning: localWarning
    };
  }

  return {
    attempted: true,
    ok: false,
    schemaUrl,
    schemaLibrary: parsed?.library,
    schemaVersion: parsed?.version,
    warning: localWarning,
    errors: (validate.errors || []).map((err) => `${err.instancePath || '/'} ${err.message || 'invalid'}`)
  };
}

async function loadLocalSchema(library: SpecFormat): Promise<unknown> {
  const packageEntryPath = require.resolve(library === 'vega' ? 'vega' : 'vega-lite');
  const packageRoot = dirname(dirname(packageEntryPath));
  const schemaPath = resolve(
    packageRoot,
    library === 'vega' ? 'build/vega-schema.json' : 'build/vega-lite-schema.json'
  );
  const text = await readFile(schemaPath, 'utf8');
  return JSON.parse(text);
}

function parseSchemaUrl(url: string): { library: SpecFormat; version: string } | undefined {
  const match = /^https?:\/\/vega\.github\.io\/schema\/(vega|vega-lite)\/([^/]+)\.json$/i.exec(url.trim());
  if (!match) {
    return undefined;
  }

  return {
    library: match[1].toLowerCase() === 'vega-lite' ? 'vega-lite' : 'vega',
    version: match[2]
  };
}

async function runRuntimeDebug(args: {
  vegaSpec: JsonObject;
  logLevel: LogLevel;
  signalNames: string[];
  dataNames: string[];
  setSignals: string[];
  includeState: boolean;
  includeRuntime: boolean;
  sampleSize: number;
}): Promise<DebugReport['runtime']> {
  const logs: LogEntry[] = [];
  let runtimeLoggedError: string | undefined;

  let view: vega.View;
  try {
    const runtime = vega.parse(args.vegaSpec);
    view = new vega.View(runtime, {
      renderer: 'none',
      logger: createVegaLogger(args.logLevel, logs, (message) => {
        runtimeLoggedError = message;
      })
    });

    for (const assignment of args.setSignals) {
      const [name, rawValue] = parseSignalAssignment(assignment);
      view.signal(name, parseMaybeJSON(rawValue));
    }

    await view.runAsync();
  } catch (err) {
    return {
      success: false,
      error: toErrorMessage(err, true),
      logs,
      availableSignals: [],
      availableData: [],
      inspectedSignals: [],
      inspectedData: []
    };
  }

  if (runtimeLoggedError) {
    return {
      success: false,
      error: runtimeLoggedError,
      logs,
      availableSignals: [],
      availableData: [],
      inspectedSignals: [],
      inspectedData: []
    };
  }

  const signalNames = extractSignalNames(args.vegaSpec);
  const dataNames = extractDataNames(args.vegaSpec);
  const inspectSignals = args.signalNames.length > 0 ? args.signalNames : signalNames;
  const inspectData = args.dataNames.length > 0 ? args.dataNames : dataNames;

  const inspectedSignals: RuntimeSignalSummary[] = [];
  for (const name of inspectSignals) {
    try {
      inspectedSignals.push({ name, value: view.signal(name) });
    } catch {
      inspectedSignals.push({ name, value: '[not available]' });
    }
  }

  const inspectedData: RuntimeDataSummary[] = [];
  for (const name of inspectData) {
    try {
      const values = view.data(name);
      inspectedData.push({
        name,
        size: Array.isArray(values) ? values.length : 0,
        sample: Array.isArray(values) ? values.slice(0, args.sampleSize) : []
      });
    } catch {
      inspectedData.push({ name, size: 0, sample: [] });
    }
  }

  return {
    success: true,
    logs,
    availableSignals: signalNames,
    availableData: dataNames,
    inspectedSignals,
    inspectedData,
    state: args.includeState ? view.getState() : undefined,
    runtimeSummary: args.includeRuntime ? summarizeRuntime(view) : undefined
  };
}

function summarizeRuntime(view: vega.View): DebugReport['runtime']['runtimeSummary'] {
  const runtime = (view as unknown as { _runtime?: Record<string, unknown> })._runtime;
  if (!runtime || typeof runtime !== 'object') {
    return {
      signalOperators: 0,
      dataNodes: 0,
      scaleOperators: 0,
      subcontextCount: 0,
      nodeCount: 0
    };
  }

  return {
    signalOperators: isObject(runtime.signals) ? Object.keys(runtime.signals).length : 0,
    dataNodes: isObject(runtime.data) ? Object.keys(runtime.data).length : 0,
    scaleOperators: isObject(runtime.scales) ? Object.keys(runtime.scales).length : 0,
    subcontextCount: Array.isArray(runtime.subcontext) ? runtime.subcontext.length : 0,
    nodeCount: isObject(runtime.nodes) ? Object.keys(runtime.nodes).length : 0
  };
}

function extractSignalNames(spec: JsonObject): string[] {
  if (!Array.isArray(spec.signals)) {
    return [];
  }
  return spec.signals
    .map((signal) => (isObject(signal) && typeof signal.name === 'string' ? signal.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function extractDataNames(spec: JsonObject): string[] {
  if (!Array.isArray(spec.data)) {
    return [];
  }
  return spec.data
    .map((dataset) => (isObject(dataset) && typeof dataset.name === 'string' ? dataset.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function parseSignalAssignment(input: string): [string, string] {
  const idx = input.indexOf('=');
  if (idx <= 0 || idx >= input.length - 1) {
    throw new Error(`Invalid --set-signal value "${input}". Expected name=value.`);
  }

  const name = input.slice(0, idx).trim();
  const rawValue = input.slice(idx + 1).trim();
  if (!name || !rawValue) {
    throw new Error(`Invalid --set-signal value "${input}". Expected name=value.`);
  }

  return [name, rawValue];
}

function parseMaybeJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toVegaLogLevel(level: LogLevel): number {
  switch (level) {
    case 'error':
      return vega.Error;
    case 'warn':
      return vega.Warn;
    case 'info':
      return vega.Info;
    case 'debug':
      return vega.Debug;
    default:
      return vega.Warn;
  }
}

function createVegaLogger(
  level: LogLevel,
  logs: LogEntry[],
  onError: (message: string) => void
) {
  return vega.logger(
    toVegaLogLevel(level),
    undefined,
    (method: 'error' | 'warn' | 'log', _levelLabel: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG', input: readonly unknown[]) => {
      const text = Array.from(input).map(stringifyUnknown).join(' ');
      if (method === 'error') {
        logs.push({ level: 'error', message: text });
        onError(text);
      } else if (method === 'warn') {
        logs.push({ level: 'warn', message: text });
      } else {
        logs.push({ level: 'info', message: text });
      }
    }
  );
}

function collectIssues(report: DebugReport): IssuesBlock {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (report.schemaValidation.warning) {
    warnings.push({ source: 'schema', level: 'warning', message: report.schemaValidation.warning });
  }

  for (const schemaError of report.schemaValidation.errors || []) {
    errors.push({ source: 'schema', level: 'error', message: schemaError });
  }

  for (const log of report.compile.logs) {
    if (log.level === 'warn') {
      warnings.push({ source: 'compile', level: 'warning', message: log.message });
    } else if (log.level === 'error') {
      errors.push({ source: 'compile', level: 'error', message: log.message });
    }
  }

  for (const log of report.runtime.logs) {
    if (log.level === 'warn') {
      warnings.push({ source: 'runtime', level: 'warning', message: log.message });
    } else if (log.level === 'error') {
      errors.push({ source: 'runtime', level: 'error', message: log.message });
    }
  }

  if (report.runtime.error) {
    errors.push({ source: 'runtime', level: 'error', message: report.runtime.error });
  }

  return { errors, warnings };
}

function tuneReport(report: DebugReport, options: TuningOptions): void {
  const sanitize = (text: string) => sanitizeMessage(text, options.includeStack);

  if (report.schemaValidation.warning) {
    report.schemaValidation.warning = sanitize(report.schemaValidation.warning);
  }

  report.schemaValidation.errors = (report.schemaValidation.errors || []).map(sanitize);
  if (options.dedupe) {
    report.schemaValidation.errors = dedupeStrings(report.schemaValidation.errors);
  }
  report.schemaValidation.errors = report.schemaValidation.errors.slice(0, options.maxErrors);

  report.compile.logs = report.compile.logs.map((log) => ({ ...log, message: sanitize(log.message) }));
  report.runtime.logs = report.runtime.logs.map((log) => ({ ...log, message: sanitize(log.message) }));
  if (report.runtime.error) {
    report.runtime.error = sanitize(report.runtime.error);
  }

  report.issues.errors = report.issues.errors.map((issue) => ({ ...issue, message: sanitize(issue.message) }));
  report.issues.warnings = report.issues.warnings.map((issue) => ({ ...issue, message: sanitize(issue.message) }));

  if (options.dedupe) {
    report.issues.errors = dedupeIssues(report.issues.errors);
    report.issues.warnings = dedupeIssues(report.issues.warnings);
  }

  const totalErrors = report.issues.errors.length;
  const totalWarnings = report.issues.warnings.length;

  report.issues.errors = report.issues.errors.slice(0, options.maxErrors);
  report.issues.warnings = report.issues.warnings.slice(0, options.maxWarnings);
  report.issues.summary = {
    totalErrors,
    totalWarnings,
    shownErrors: report.issues.errors.length,
    shownWarnings: report.issues.warnings.length,
    deduplicated: options.dedupe,
    truncated: totalErrors > report.issues.errors.length || totalWarnings > report.issues.warnings.length
  };
}

function sanitizeMessage(message: string, includeStack: boolean): string {
  const trimmed = message.trim();
  if (includeStack) {
    return trimmed;
  }
  const firstLine = trimmed.split('\n')[0];
  return firstLine || trimmed;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];

  for (const issue of issues) {
    const key = `${issue.source}|${issue.level}|${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(issue);
  }

  return out;
}

function minimalIssuePayload(report: DebugReport, includeSchemaErrors: boolean) {
  return {
    input: report.input,
    issues: report.issues,
    schemaValidation: {
      attempted: report.schemaValidation.attempted,
      ok: report.schemaValidation.ok,
      schemaUrl: report.schemaValidation.schemaUrl,
      warning: report.schemaValidation.warning,
      errors: includeSchemaErrors ? report.schemaValidation.errors : undefined
    },
    compile: {
      applied: report.compile.applied
    },
    runtime: {
      success: report.runtime.success,
      error: report.runtime.error
    }
  };
}

function formatTextReport(report: DebugReport): string {
  const lines: string[] = [];
  lines.push(`Spec: ${report.input.specPath}`);
  lines.push(`Format: ${report.input.format}`);
  lines.push('');

  const summary = report.issues.summary;
  if (summary) {
    lines.push(
      `Errors (${summary.shownErrors}/${summary.totalErrors}), Warnings (${summary.shownWarnings}/${summary.totalWarnings})`
    );
  } else {
    lines.push(`Errors (${report.issues.errors.length}), Warnings (${report.issues.warnings.length})`);
  }

  for (const issue of report.issues.errors) {
    lines.push(`- [${issue.source}] ${issue.message}`);
  }
  for (const issue of report.issues.warnings) {
    lines.push(`- [${issue.source}] ${issue.message}`);
  }

  lines.push('');
  lines.push(`Runtime success: ${report.runtime.success ? 'yes' : 'no'}`);
  lines.push(`Signals available: ${report.runtime.availableSignals.length}`);
  lines.push(`Data sets available: ${report.runtime.availableData.length}`);
  return `${lines.join('\n')}\n`;
}

async function writeReport(
  report: DebugReport,
  outPath: string | undefined,
  outputMode: OutputMode,
  onlyIssues: boolean,
  includeSchemaErrors: boolean
): Promise<void> {
  const payload = onlyIssues ? minimalIssuePayload(report, includeSchemaErrors) : report;
  if (!includeSchemaErrors && payload && typeof payload === 'object' && 'schemaValidation' in payload) {
    const withSchema = payload as { schemaValidation?: SchemaValidationResult };
    if (withSchema.schemaValidation) {
      withSchema.schemaValidation = {
        ...withSchema.schemaValidation,
        errors: undefined
      };
    }
  }
  const text = outputMode === 'json'
    ? `${JSON.stringify(payload, null, 2)}\n`
    : formatTextReport(report);

  if (outPath) {
    await writeFile(resolve(outPath), text, 'utf8');
    return;
  }

  process.stdout.write(text);
}

function stringifyLog(parts: unknown[]): string {
  return parts
    .map(stringifyUnknown)
    .join(' ');
}

function stringifyUnknown(part: unknown): string {
  if (part instanceof Error) {
    return part.stack || part.message;
  }
  if (typeof part === 'string') {
    return part;
  }
  if (isObject(part) && typeof part.message === 'string') {
    return String(part.message);
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(err: unknown, includeStack: boolean): string {
  if (err instanceof Error) {
    const message = includeStack ? (err.stack || err.message) : err.message;
    return message || String(err);
  }
  return String(err);
}

const bunArgv = (globalThis as { Bun?: { argv: string[] } }).Bun?.argv;
const argv = bunArgv ? bunArgv.slice(2) : process.argv.slice(2);
void main(argv).then((code) => {
  process.exitCode = code;
});
