#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as vega from 'vega';
import { compile as compileVegaLite } from 'vega-lite';

type SpecFormat = 'vega' | 'vega-lite';
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

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

type DebugReport = {
  input: {
    specPath: string;
    format: SpecFormat;
  };
  issues: {
    errors: Issue[];
    warnings: Issue[];
  };
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

type OutputMode = 'json' | 'text';
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
      --output <mode>        Output mode: json | text (default: json).
      --print-compiled       Include compiled Vega spec in output report.
  -o, --out <path>           Write output JSON report to a file.
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
        output: { type: 'string', default: 'json' },
        'print-compiled': { type: 'boolean', default: false },
        out: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h', default: false }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (err) {
    process.stderr.write(`${toErrorMessage(err)}\n\n${HELP_TEXT}`);
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

  const sampleSize = Number(parsed.values['sample-size']);
  if (!Number.isInteger(sampleSize) || sampleSize < 0) {
    process.stderr.write('Invalid --sample-size. Use a non-negative integer.\n');
    return 1;
  }

  const outputMode = parsed.values.output;
  if (outputMode !== 'json' && outputMode !== 'text') {
    process.stderr.write('Invalid --output. Use json or text.\n');
    return 1;
  }
  const normalizedOutputMode: OutputMode = outputMode;

  const specPath = resolve(specPathRaw);

  let inputSpec: unknown;
  try {
    const text = await readFile(specPath, 'utf8');
    inputSpec = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`Failed to read spec: ${toErrorMessage(err)}\n`);
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
    format: detectedFormat,
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
          logs: [
            ...compileLogs,
            { level: 'error', message: toErrorMessage(err) }
          ]
        },
        runtime: {
          success: false,
          error: `Vega-Lite compile failed: ${toErrorMessage(err)}`,
          logs: [],
          availableSignals: [],
          availableData: [],
          inspectedSignals: [],
          inspectedData: []
        }
      };
      report.issues = collectIssues(report);

      await writeReport(report, parsed.values.out, normalizedOutputMode);
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
    input: {
      specPath,
      format: detectedFormat
    },
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

  await writeReport(report, parsed.values.out, normalizedOutputMode);

  return runtime.success ? 0 : 2;
}

function detectFormat(spec: JsonObject, formatArg: 'auto' | SpecFormat): SpecFormat {
  if (formatArg !== 'auto') {
    return formatArg;
  }

  const schema = typeof spec.$schema === 'string' ? spec.$schema.toLowerCase() : '';
  if (schema.includes('/vega-lite/')) {
    return 'vega-lite';
  }

  return 'vega';
}

async function validateSchema(args: {
  inputSpec: JsonObject;
  format: SpecFormat;
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
    remoteError = toErrorMessage(err);
  }

  let localWarning: string | undefined;
  if (!schemaDoc && parsed) {
    try {
      schemaDoc = await loadLocalSchema(parsed.library);
      if (remoteError) {
        localWarning = `Remote schema fetch failed; validated with local ${parsed.library} schema from installed package.`;
      }
    } catch (localErr) {
      const errors = [remoteError, toErrorMessage(localErr)].filter(Boolean) as string[];
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

  const library = match[1].toLowerCase() === 'vega-lite' ? 'vega-lite' : 'vega';
  return {
    library,
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

  let view: vega.View;
  try {
    const runtime = vega.parse(args.vegaSpec);
    view = new vega.View(runtime, { renderer: 'none' });

    view.logLevel(toVegaLogLevel(args.logLevel));

    for (const assignment of args.setSignals) {
      const [name, rawValue] = parseSignalAssignment(assignment);
      view.signal(name, parseMaybeJSON(rawValue));
    }

    await view.runAsync();
  } catch (err) {
    return {
      success: false,
      error: toErrorMessage(err),
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
      inspectedSignals.push({
        name,
        value: view.signal(name)
      });
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
      inspectedData.push({
        name,
        size: 0,
        sample: []
      });
    }
  }

  const state = args.includeState ? view.getState() : undefined;
  const runtimeSummary = args.includeRuntime ? summarizeRuntime(view) : undefined;

  return {
    success: true,
    logs,
    availableSignals: signalNames,
    availableData: dataNames,
    inspectedSignals,
    inspectedData,
    state,
    runtimeSummary
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

  const signals = isObject(runtime.signals) ? Object.keys(runtime.signals).length : 0;
  const data = isObject(runtime.data) ? Object.keys(runtime.data).length : 0;
  const scales = isObject(runtime.scales) ? Object.keys(runtime.scales).length : 0;
  const nodes = isObject(runtime.nodes) ? Object.keys(runtime.nodes).length : 0;
  const subcontext = Array.isArray(runtime.subcontext) ? runtime.subcontext.length : 0;

  return {
    signalOperators: signals,
    dataNodes: data,
    scaleOperators: scales,
    subcontextCount: subcontext,
    nodeCount: nodes
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

function collectIssues(report: DebugReport): DebugReport['issues'] {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (report.schemaValidation.warning) {
    warnings.push({
      source: 'schema',
      level: 'warning',
      message: report.schemaValidation.warning
    });
  }

  for (const schemaError of report.schemaValidation.errors || []) {
    errors.push({
      source: 'schema',
      level: 'error',
      message: schemaError
    });
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
    errors.push({
      source: 'runtime',
      level: 'error',
      message: report.runtime.error
    });
  }

  return { errors, warnings };
}

function formatTextReport(report: DebugReport): string {
  const lines: string[] = [];
  lines.push(`Spec: ${report.input.specPath}`);
  lines.push(`Format: ${report.input.format}`);
  lines.push('');
  lines.push(`Errors (${report.issues.errors.length})`);
  for (const issue of report.issues.errors) {
    lines.push(`- [${issue.source}] ${issue.message}`);
  }
  lines.push('');
  lines.push(`Warnings (${report.issues.warnings.length})`);
  for (const issue of report.issues.warnings) {
    lines.push(`- [${issue.source}] ${issue.message}`);
  }
  lines.push('');
  lines.push(`Runtime success: ${report.runtime.success ? 'yes' : 'no'}`);
  lines.push(`Signals available: ${report.runtime.availableSignals.length}`);
  lines.push(`Data sets available: ${report.runtime.availableData.length}`);
  return `${lines.join('\n')}\n`;
}

async function writeReport(report: DebugReport, outPath: string | undefined, outputMode: OutputMode): Promise<void> {
  const text = outputMode === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatTextReport(report);
  if (outPath) {
    await writeFile(resolve(outPath), text, 'utf8');
    return;
  }

  process.stdout.write(text);
}

function stringifyLog(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return String(err);
}

const bunArgv = (globalThis as { Bun?: { argv: string[] } }).Bun?.argv;
const argv = bunArgv ? bunArgv.slice(2) : process.argv.slice(2);
void main(argv).then((code) => {
  process.exitCode = code;
});
