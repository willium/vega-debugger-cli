# vega-debugger-cli

CLI for agent-friendly Vega / Vega-Lite debugging.

It does three core things:

1. Validates a spec against its JSON schema (`$schema` or `--schema-url`).
2. Compiles Vega-Lite to Vega when needed.
3. Runs the Vega runtime headlessly and inspects signals, data, state, and runtime internals.

Default output is JSON and includes normalized diagnostics:

- `issues.errors[]`
- `issues.warnings[]`

Each issue includes `source` (`schema`, `compile`, `runtime`) and `message`.

## Install

```bash
bun install
```

## Build

```bash
bun run build
```

## Run

```bash
bun run src/cli.ts --help
```

After build:

```bash
node dist/cli.js --help
```

## Examples

Debug a Vega-Lite spec and print JSON report:

```bash
bun run src/cli.ts --spec ./examples/simple.vl.json
```

Inspect specific runtime items:

```bash
bun run src/cli.ts \
  --spec ./examples/simple.vg.json \
  --signal width \
  --data source_0 \
  --state \
  --runtime
```

Set a signal before run:

```bash
bun run src/cli.ts --spec ./examples/simple.vg.json --set-signal width=500
```

Text mode output:

```bash
bun run src/cli.ts --spec ./examples/simple.vl.json --output text
```

Write report to file:

```bash
bun run src/cli.ts --spec ./examples/simple.vl.json --out ./debug-report.json
```

## Output shape

```json
{
  "input": { "specPath": "...", "format": "vega-lite" },
  "issues": {
    "errors": [{ "source": "schema", "level": "error", "message": "..." }],
    "warnings": [{ "source": "compile", "level": "warning", "message": "..." }]
  },
  "schemaValidation": { "attempted": true, "ok": false, "errors": ["..."] },
  "compile": { "applied": true, "logs": [] },
  "runtime": {
    "success": true,
    "logs": [],
    "availableSignals": ["width", "height"],
    "availableData": ["source_0"],
    "inspectedSignals": [{ "name": "width", "value": 200 }],
    "inspectedData": [{ "name": "source_0", "size": 2, "sample": [{ "x": 1 }] }]
  }
}
```

## Notes

- Schema URL parsing follows Vega schema URL conventions.
- Nested group signals/data are not directly accessible via `view.signal` / `view.data`; use `--state` and `--runtime` for deeper inspection.
