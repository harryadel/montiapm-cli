# montiapm-cli

Zero-dependency CLI and MCP server for the Monti APM REST API (`https://api.montiapm.com/v1`).
Node 18+. MIT licensed.

## Install

```bash
git clone https://github.com/harryadel/montiapm-cli.git
cd montiapm-cli
npm link            # puts the `montiapm` command on your PATH (optional)
```

Everything below works with `node montiapm.mjs …` too; `montiapm …` is the linked form.

## Auth

The token is read from, in order:

1. `MONTI_API_TOKEN` env var
2. the file named by `MONTI_API_TOKEN_FILE`
3. `~/.config/montiapm/token` (default)

Default app ids come from `MONTI_APP_ID` (comma separated). `--app` overrides.

## CLI

```bash
node montiapm.mjs metrics [--collection system] [--json]

node montiapm.mjs query --metric system.pcpu --agg avg \
  --from 6h --to now \                # ISO, epoch ms, or relative (30m, 6h, 7d)
  --dim tag:host \                    # one series per host/container
  --filter 'tag:host~z8qft$' \        # tag:host=value | tag:host!=value | tag:host~regex
  --step 5m \                         # client-side downsample (API returns 1-minute points)
  --json | --csv                      # default is a readable table

node montiapm.mjs query --metric methods.total --agg avg --type breakdown --dim tag:name --from 1h
node montiapm.mjs query --metric system.sessions --agg max --type summary --from 24h
node montiapm.mjs mcp                 # stdio MCP server
```

## API shape (discovered by probing; Monti has no public docs for this)

`GET /v1/metrics` returns `{collections:[{id, displayName, dimensions, filters, metrics:[{id, aggregations}]}]}`.
Collections: `system`, `methods`, `pubs`, `http`, `jobs`, `errors`.

`POST /v1/query` body:

| key | required | notes |
|---|---|---|
| `appIds` | yes | array of Monti app ids |
| `type` | yes | `timeseries` \| `summary` \| `breakdown` |
| `metric` | yes | e.g. `system.pcpu` |
| `aggregation` | no | from the metric's aggregation list |
| `startTime`, `endTime` | no | epoch **milliseconds**; default last hour; ranges outside the plan's retention are refused |
| `dimensions` | breakdown: yes | array, e.g. `["tag:host"]` |
| `filters` | no | array of `{tagId, operator: is\|isNot\|matchesRegex, values: [..]}` |

There is no server-side step/resolution key; timeseries points are 1 minute apart.
Responses are flat parallel arrays: `timestamps[]`, `metrics[metric][]`, `tags[dim][]`, one row per (dimension value, timestamp).
The script regroups these into one series per label and can downsample with `--step`.

`system.pcpu` is percent of one core per host, so a 2-CPU container can read up to 200.

## MCP

Register it in Claude Code as `montiapm-rest` (replace the path with your clone):

```bash
claude mcp add-json --scope user montiapm-rest \
  '{"type":"stdio","command":"node","args":["/path/to/montiapm-cli/montiapm.mjs","mcp"],"env":{"MONTI_APP_ID":"<app id>"}}'
```

Tools: `list_metrics`, `query_metric` (same options as the CLI; pass `includePoints: false` for summaries only).

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.montiapm-rest]
command = "node"
args = ["/path/to/montiapm-cli/montiapm.mjs", "mcp"]
[mcp_servers.montiapm-rest.env]
MONTI_APP_ID = "<app id>"
```
