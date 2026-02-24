#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as vega from 'vega';
import { compile as compileVegaLite } from 'vega-lite';

type SpecFormat = 'vega' | 'vega-lite';
type LogLevel = 'error' | 'warn' | 'info' | 'debug';
type OutputMode = 'json' | 'text';
type Severity = 'error' | 'warning';
type Stage = 'schema' | 'compile' | 'runtime';

type JsonObject = Record<string, unknown>;

type Diagnostic = {
  code: string;
  severity: Severity;
  stage: Stage;
  pointer: string;
  message: string;
  hints: string[];
};

type SchemaValidationSummary = {
  attempted: boolean;
  ok: boolean;
  schemaUrl?: string;
  schemaLibrary?: SpecFormat;
  schemaVersion?: string;
  warning?: string;
  errorCount: number;
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
  reportSchemaVersion: string;
  input: {
    specPath: string;
    format: SpecFormat;
  };
  summary: {
    totalDiagnostics: number;
    errorCount: number;
    warningCount: number;
    truncated: boolean;
    deduplicated: boolean;
  };
  diagnostics: Diagnostic[];
  nextActions: string[];
  schemaValidation: SchemaValidationSummary;
  compile: {
    applied: boolean;
    ok: boolean;
  };
  runtime: {
    ok: boolean;
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

type SchemaValidationResult = {
  summary: SchemaValidationSummary;
  diagnostics: Diagnostic[];
};

const REPORT_SCHEMA_VERSION = '1.0.0';
const require = createRequire(import.meta.url);

const REPORT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vega.github.io/vega-debugger/report.schema.json',
  title: 'Vega Debugger Report',
  type: 'object',
  required: ['reportSchemaVersion', 'input', 'summary', 'diagnostics', 'nextActions', 'schemaValidation', 'compile', 'runtime'],
  properties: {
    reportSchemaVersion: { type: 'string' },
    input: {
      type: 'object',
      required: ['specPath', 'format'],
      properties: {
        specPath: { type: 'string' },
        format: { enum: ['vega', 'vega-lite'] }
      }
    },
    summary: {
      type: 'object',
      required: ['totalDiagnostics', 'errorCount', 'warningCount', 'truncated', 'deduplicated']
    },
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'severity', 'stage', 'pointer', 'message', 'hints'],
        properties: {
          code: { type: 'string' },
          severity: { enum: ['error', 'warning'] },
          stage: { enum: ['schema', 'compile', 'runtime'] },
          pointer: { type: 'string' },
          message: { type: 'string' },
          hints: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    nextActions: { type: 'array', items: { type: 'string' } }
  }
};

const HELP_TEXT = `Usage:
  vega-debugger --spec <spec.json> [options]

Options:
  -s, --spec <path>           Path to Vega or Vega-Lite JSON spec.
  -f, --format <type>         Spec type: auto | vega | vega-lite (default: auto).
      --schema-url <url>      Override schema URL used for JSON schema validation.
      --no-validate-schema    Skip schema validation step.
      --signal <name>         Signal name to inspect (repeatable).
      --data <name>           Data set name to inspect (repeatable).
      --set-signal <k=v>      Set signal before run; value parsed as JSON if possible.
      --state                 Include view.getState() snapshot.
      --runtime               Include runtime internals summary from view._runtime.
      --log-level <level>     Runtime log level: error | warn | info | debug (default: warn).
      --sample-size <n>       Rows to include in each data sample (default: 5).
      --max-errors <n>        Max error diagnostics (0 = unlimited, default: 0).
      --max-warnings <n>      Max warning diagnostics (0 = unlimited, default: 0).
      --no-dedupe             Disable deduplication of repeated diagnostics.
      --include-stack         Keep full stack traces in diagnostic messages.
      --only-issues           Emit minimal payload: summary/diagnostics/nextActions.
      --output-schema         Print the JSON schema for this report and exit.
      --output <mode>         Output mode: json | text (default: json).
      --print-compiled        Include compiled Vega spec in output report.
  -o, --out <path>            Write output report to a file.
  -h, --help                  Show this message.
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
        'max-errors': { type: 'string', default: '0' },
        'max-warnings': { type: 'string', default: '0' },
        'no-dedupe': { type: 'boolean', default: false },
        'include-stack': { type: 'boolean', default: false },
        'only-issues': { type: 'boolean', default: false },
        'output-schema': { type: 'boolean', default: false },
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

  if (parsed.values['output-schema']) {
    process.stdout.write(`${JSON.stringify(REPORT_JSON_SCHEMA, null, 2)}\n`);
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
  const schemaValidation = await validateSchema({
    inputSpec,
    schemaOverrideUrl: parsed.values['schema-url'],
    skipValidation: parsed.values['no-validate-schema']
  });

  const diagnostics: Diagnostic[] = [...schemaValidation.diagnostics];
  const compileApplied = detectedFormat === 'vega-lite';
  let compileOk = true;

  let vegaSpec: JsonObject;
  if (compileApplied) {
    try {
      const compiled = compileVegaLite(inputSpec as never);
      vegaSpec = compiled.spec as JsonObject;
    } catch (err) {
      compileOk = false;
      diagnostics.push(buildDiagnostic('compile', 'error', toErrorMessage(err, true), '/'));
      diagnostics.push(buildDiagnostic('runtime', 'error', `Vega-Lite compile failed: ${toErrorMessage(err, true)}`, '/'));

      const report = finalizeReport({
        specPath,
        format: detectedFormat,
        diagnostics,
        schemaSummary: schemaValidation.summary,
        compileApplied,
        compileOk,
        runtimeOk: false,
        runtimeSignalNames: [],
        runtimeDataNames: [],
        inspectedSignals: [],
        inspectedData: [],
        tuning,
        includeCompiledSpec: parsed.values['print-compiled'],
        compiledSpec: undefined,
        includeState: false,
        runtimeSummary: undefined,
        state: undefined
      });

      await writeReport(report, parsed.values.out, outputMode, parsed.values['only-issues']);
      return 2;
    }
  } else {
    vegaSpec = inputSpec;
  }

  const runtimeResult = await runRuntimeDebug({
    vegaSpec,
    logLevel,
    signalNames: parsed.values.signal || [],
    dataNames: parsed.values.data || [],
    setSignals: parsed.values['set-signal'] || [],
    includeState: parsed.values.state,
    includeRuntime: parsed.values.runtime,
    sampleSize
  });

  diagnostics.push(...runtimeResult.diagnostics);

  const report = finalizeReport({
    specPath,
    format: detectedFormat,
    diagnostics,
    schemaSummary: schemaValidation.summary,
    compileApplied,
    compileOk,
    runtimeOk: runtimeResult.ok,
    runtimeSignalNames: runtimeResult.availableSignals,
    runtimeDataNames: runtimeResult.availableData,
    inspectedSignals: runtimeResult.inspectedSignals,
    inspectedData: runtimeResult.inspectedData,
    tuning,
    includeCompiledSpec: parsed.values['print-compiled'],
    compiledSpec: vegaSpec,
    includeState: parsed.values.state,
    state: runtimeResult.state,
    runtimeSummary: runtimeResult.runtimeSummary
  });

  await writeReport(report, parsed.values.out, outputMode, parsed.values['only-issues']);
  return report.summary.errorCount === 0 ? 0 : 2;
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
    return {
      summary: { attempted: false, ok: true, warning: 'Skipped (--no-validate-schema).', errorCount: 0 },
      diagnostics: [buildDiagnostic('schema', 'warning', 'Skipped schema validation.', '/')]
    };
  }

  const schemaUrl = schemaOverrideUrl || (typeof inputSpec.$schema === 'string' ? inputSpec.$schema : undefined);
  if (!schemaUrl) {
    return {
      summary: { attempted: false, ok: true, warning: 'No $schema found.', errorCount: 0 },
      diagnostics: [buildDiagnostic('schema', 'warning', 'No $schema found; pass --schema-url to validate explicitly.', '/$schema')]
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

  let fallbackWarning: string | undefined;
  if (!schemaDoc && parsed) {
    try {
      schemaDoc = await loadLocalSchema(parsed.library);
      if (remoteError) {
        fallbackWarning = `Remote schema fetch failed; validated with local ${parsed.library} schema from installed package.`;
      }
    } catch (localErr) {
      const msg = [remoteError, toErrorMessage(localErr, true)].filter(Boolean).join(' | ');
      return {
        summary: {
          attempted: true,
          ok: false,
          schemaUrl,
          schemaLibrary: parsed.library,
          schemaVersion: parsed.version,
          errorCount: 1
        },
        diagnostics: [buildDiagnostic('schema', 'error', msg || 'Unable to load schema.', '/$schema')]
      };
    }
  }

  if (!schemaDoc) {
    return {
      summary: {
        attempted: true,
        ok: false,
        schemaUrl,
        schemaLibrary: parsed?.library,
        schemaVersion: parsed?.version,
        errorCount: 1
      },
      diagnostics: [buildDiagnostic('schema', 'error', remoteError || 'Unable to load schema.', '/$schema')]
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat('color-hex', true);
  const validate = ajv.compile(schemaDoc);
  const valid = validate(inputSpec);

  const schemaDiagnostics: Diagnostic[] = [];
  if (fallbackWarning) {
    schemaDiagnostics.push(buildDiagnostic('schema', 'warning', fallbackWarning, '/$schema'));
  }

  if (!valid) {
    for (const err of validate.errors || []) {
      schemaDiagnostics.push(ajvErrorToDiagnostic(err));
    }
  }

  return {
    summary: {
      attempted: true,
      ok: Boolean(valid),
      schemaUrl,
      schemaLibrary: parsed?.library,
      schemaVersion: parsed?.version,
      warning: fallbackWarning,
      errorCount: schemaDiagnostics.filter((d) => d.severity === 'error').length
    },
    diagnostics: schemaDiagnostics
  };
}

function ajvErrorToDiagnostic(err: ErrorObject): Diagnostic {
  const pointer = err.instancePath || '/';
  const keyword = err.keyword;
  const baseMessage = `${pointer} ${err.message || 'invalid'}`;
  const hints: string[] = [];

  if (keyword === 'enum') {
    hints.push('Use one of the allowed enum values for this field.');
  } else if (keyword === 'required') {
    const missing = String((err.params as { missingProperty?: string }).missingProperty || '');
    hints.push(`Add required property \"${missing}\" at ${pointer}.`);
  } else if (keyword === 'additionalProperties') {
    const prop = String((err.params as { additionalProperty?: string }).additionalProperty || '');
    hints.push(`Remove unknown property \"${prop}\" or move it to the correct object.`);
  } else if (keyword === 'type') {
    const expected = String((err.params as { type?: string }).type || 'the expected type');
    hints.push(`Change this value to type \"${expected}\".`);
  } else if (keyword === 'anyOf' || keyword === 'oneOf') {
    hints.push('Adjust this object so it matches one valid schema variant.');
  } else {
    hints.push('Update this part of the spec to satisfy the schema constraint.');
  }

  return {
    code: `SCHEMA_${keyword.toUpperCase()}`,
    severity: 'error',
    stage: 'schema',
    pointer,
    message: baseMessage,
    hints
  };
}

async function loadLocalSchema(library: SpecFormat): Promise<unknown> {
  const packageEntryPath = require.resolve(library === 'vega' ? 'vega' : 'vega-lite');
  const packageRoot = dirname(dirname(packageEntryPath));
  const schemaPath = resolve(packageRoot, library === 'vega' ? 'build/vega-schema.json' : 'build/vega-lite-schema.json');
  return JSON.parse(await readFile(schemaPath, 'utf8'));
}

function parseSchemaUrl(url: string): { library: SpecFormat; version: string } | undefined {
  const match = /^https?:\/\/vega\.github\.io\/schema\/(vega|vega-lite)\/([^/]+)\.json$/i.exec(url.trim());
  if (!match) {
    return undefined;
  }
  return { library: match[1].toLowerCase() === 'vega-lite' ? 'vega-lite' : 'vega', version: match[2] };
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
}): Promise<{
  ok: boolean;
  diagnostics: Diagnostic[];
  availableSignals: string[];
  availableData: string[];
  inspectedSignals: RuntimeSignalSummary[];
  inspectedData: RuntimeDataSummary[];
  state?: unknown;
  runtimeSummary?: DebugReport['runtime']['runtimeSummary'];
}> {
  const diagnostics: Diagnostic[] = [];
  let runtimeLoggedError: string | undefined;

  let view: vega.View;
  try {
    const runtime = vega.parse(args.vegaSpec);
    view = new vega.View(runtime, {
      renderer: 'none',
      logger: createVegaLogger(args.logLevel, diagnostics, (message) => {
        runtimeLoggedError = message;
      })
    });

    for (const assignment of args.setSignals) {
      const [name, rawValue] = parseSignalAssignment(assignment);
      view.signal(name, parseMaybeJSON(rawValue));
    }

    await view.runAsync();
  } catch (err) {
    diagnostics.push(buildDiagnostic('runtime', 'error', toErrorMessage(err, true), '/'));
    return {
      ok: false,
      diagnostics,
      availableSignals: [],
      availableData: [],
      inspectedSignals: [],
      inspectedData: []
    };
  }

  if (runtimeLoggedError) {
    diagnostics.push(buildDiagnostic('runtime', 'error', runtimeLoggedError, '/'));
    return {
      ok: false,
      diagnostics,
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
      diagnostics.push(buildDiagnostic('runtime', 'warning', `Signal not available: ${name}`, `/signals/${name}`));
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
      diagnostics.push(buildDiagnostic('runtime', 'warning', `Dataset not available: ${name}`, `/data/${name}`));
    }
  }

  return {
    ok: true,
    diagnostics,
    availableSignals: signalNames,
    availableData: dataNames,
    inspectedSignals,
    inspectedData,
    state: args.includeState ? view.getState() : undefined,
    runtimeSummary: args.includeRuntime ? summarizeRuntime(view) : undefined
  };
}

function createVegaLogger(
  level: LogLevel,
  diagnostics: Diagnostic[],
  onError: (message: string) => void
) {
  return vega.logger(
    toVegaLogLevel(level),
    undefined,
    (method: 'error' | 'warn' | 'log', _levelLabel: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG', input: readonly unknown[]) => {
      const text = Array.from(input).map(stringifyUnknown).join(' ');
      if (method === 'error') {
        diagnostics.push(buildDiagnostic('runtime', 'error', text, '/'));
        onError(text);
      } else if (method === 'warn') {
        diagnostics.push(buildDiagnostic('runtime', 'warning', text, '/'));
      }
    }
  );
}

function summarizeRuntime(view: vega.View): DebugReport['runtime']['runtimeSummary'] {
  const runtime = (view as unknown as { _runtime?: Record<string, unknown> })._runtime;
  if (!runtime || typeof runtime !== 'object') {
    return { signalOperators: 0, dataNodes: 0, scaleOperators: 0, subcontextCount: 0, nodeCount: 0 };
  }
  return {
    signalOperators: isObject(runtime.signals) ? Object.keys(runtime.signals).length : 0,
    dataNodes: isObject(runtime.data) ? Object.keys(runtime.data).length : 0,
    scaleOperators: isObject(runtime.scales) ? Object.keys(runtime.scales).length : 0,
    subcontextCount: Array.isArray(runtime.subcontext) ? runtime.subcontext.length : 0,
    nodeCount: isObject(runtime.nodes) ? Object.keys(runtime.nodes).length : 0
  };
}

function buildDiagnostic(stage: Stage, severity: Severity, message: string, pointer: string): Diagnostic {
  const shortMessage = message.trim();
  const code = inferCode(stage, shortMessage);
  const hints = inferHints(stage, shortMessage, pointer);
  return { code, severity, stage, pointer: pointer || '/', message: shortMessage, hints };
}

function inferCode(stage: Stage, message: string): string {
  if (stage === 'schema' && /Remote schema fetch failed/i.test(message)) return 'SCHEMA_FALLBACK_LOCAL';
  if (stage === 'compile' && /Invalid field type/i.test(message)) return 'COMPILE_INVALID_FIELD_TYPE';
  if (stage === 'runtime' && /missing_scale|is not a function/i.test(message)) return 'RUNTIME_MISSING_SCALE';
  if (stage === 'runtime') return 'RUNTIME_ERROR';
  if (stage === 'compile') return 'COMPILE_ERROR';
  return 'SCHEMA_ERROR';
}

function inferHints(stage: Stage, message: string, pointer: string): string[] {
  if (stage === 'compile' && /Invalid field type/i.test(message)) {
    return [
      'Set each encoded field type explicitly (nominal, ordinal, quantitative, temporal, geojson).',
      'Check encoding channels near the reported pointer for misspelled or missing type values.'
    ];
  }

  if (stage === 'runtime' && /missing_scale|is not a function/i.test(message)) {
    return [
      'Define the referenced scale name in top-level spec.scales.',
      'Or update mark encodings to use an existing scale name.'
    ];
  }

  if (stage === 'schema') {
    if (/Remote schema fetch failed/i.test(message)) {
      return [
        'If possible, allow network access so remote schema validation can run.',
        'Or continue with packaged schemas; validation still ran against the installed schema.'
      ];
    }
    return [
      `Fix the value at ${pointer} to satisfy the schema constraint.`,
      'If this is Vega-Lite, compare against a known valid example with the same mark type.'
    ];
  }

  return ['Review the failing field and update the spec value to a valid form.'];
}

function finalizeReport(args: {
  specPath: string;
  format: SpecFormat;
  diagnostics: Diagnostic[];
  schemaSummary: SchemaValidationSummary;
  compileApplied: boolean;
  compileOk: boolean;
  runtimeOk: boolean;
  runtimeSignalNames: string[];
  runtimeDataNames: string[];
  inspectedSignals: RuntimeSignalSummary[];
  inspectedData: RuntimeDataSummary[];
  tuning: TuningOptions;
  includeCompiledSpec: boolean;
  compiledSpec: JsonObject | undefined;
  includeState: boolean;
  state?: unknown;
  runtimeSummary?: DebugReport['runtime']['runtimeSummary'];
}): DebugReport {
  let diagnostics = args.diagnostics.map((d) => sanitizeDiagnostic(d, args.tuning.includeStack));

  if (args.tuning.dedupe) {
    diagnostics = dedupeDiagnostics(diagnostics);
  }

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  const limitedErrors = args.tuning.maxErrors === 0 ? errors : errors.slice(0, args.tuning.maxErrors);
  const limitedWarnings = args.tuning.maxWarnings === 0 ? warnings : warnings.slice(0, args.tuning.maxWarnings);
  diagnostics = [...limitedErrors, ...limitedWarnings];

  const nextActions = dedupeStrings(diagnostics.flatMap((d) => d.hints)).slice(0, 12);

  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    input: {
      specPath: args.specPath,
      format: args.format
    },
    summary: {
      totalDiagnostics: errors.length + warnings.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      deduplicated: args.tuning.dedupe,
      truncated: diagnostics.length < errors.length + warnings.length
    },
    diagnostics,
    nextActions,
    schemaValidation: args.schemaSummary,
    compile: {
      applied: args.compileApplied,
      ok: args.compileOk
    },
    runtime: {
      ok: args.runtimeOk,
      availableSignals: args.runtimeSignalNames,
      availableData: args.runtimeDataNames,
      inspectedSignals: args.inspectedSignals,
      inspectedData: args.inspectedData,
      state: args.includeState ? args.state : undefined,
      runtimeSummary: args.runtimeSummary
    },
    compiledSpec: args.includeCompiledSpec ? args.compiledSpec : undefined
  };
}

function sanitizeDiagnostic(d: Diagnostic, includeStack: boolean): Diagnostic {
  return {
    ...d,
    message: includeStack ? d.message : firstLine(d.message)
  };
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.split('\n')[0] || trimmed;
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of items) {
    const key = `${d.stage}|${d.severity}|${d.pointer}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

function extractSignalNames(spec: JsonObject): string[] {
  if (!Array.isArray(spec.signals)) return [];
  return spec.signals
    .map((signal) => (isObject(signal) && typeof signal.name === 'string' ? signal.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function extractDataNames(spec: JsonObject): string[] {
  if (!Array.isArray(spec.data)) return [];
  return spec.data
    .map((dataset) => (isObject(dataset) && typeof dataset.name === 'string' ? dataset.name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function minimalIssuePayload(report: DebugReport) {
  return {
    reportSchemaVersion: report.reportSchemaVersion,
    input: report.input,
    summary: report.summary,
    diagnostics: report.diagnostics,
    nextActions: report.nextActions
  };
}

function formatTextReport(report: DebugReport): string {
  const lines: string[] = [];
  lines.push(`Spec: ${report.input.specPath}`);
  lines.push(`Format: ${report.input.format}`);
  lines.push(`Errors: ${report.summary.errorCount}, Warnings: ${report.summary.warningCount}`);
  lines.push('');

  for (const d of report.diagnostics) {
    lines.push(`- [${d.severity}] [${d.stage}] ${d.pointer}: ${d.message}`);
    for (const hint of d.hints) {
      lines.push(`  hint: ${hint}`);
    }
  }

  if (report.nextActions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const action of report.nextActions) {
      lines.push(`- ${action}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeReport(
  report: DebugReport,
  outPath: string | undefined,
  outputMode: OutputMode,
  onlyIssues: boolean
): Promise<void> {
  const payload = onlyIssues ? minimalIssuePayload(report) : report;
  const text = outputMode === 'json' ? `${JSON.stringify(payload, null, 2)}\n` : formatTextReport(report);

  if (outPath) {
    await writeFile(resolve(outPath), text, 'utf8');
    return;
  }

  process.stdout.write(text);
}

function stringifyUnknown(part: unknown): string {
  if (part instanceof Error) return part.stack || part.message;
  if (typeof part === 'string') return part;
  if (isObject(part) && typeof part.message === 'string') return String(part.message);
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
    return includeStack ? (err.stack || err.message) : err.message;
  }
  return String(err);
}

const bunArgv = (globalThis as { Bun?: { argv: string[] } }).Bun?.argv;
const argv = bunArgv ? bunArgv.slice(2) : process.argv.slice(2);
void main(argv).then((code) => {
  process.exitCode = code;
});
