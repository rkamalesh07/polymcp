# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm start            # run compiled server (dist/index.js)
npm run dev          # run directly with ts-node (no build step)
```

## Architecture

Single-file MCP server (`src/index.ts`) using the `@modelcontextprotocol/sdk` over stdio transport.

**Data flow:** MCP client → stdio → `Server` (SDK) → tool handler → `axios` → Polymarket Gamma API → formatted plain-text response back to client.

All logic lives in `src/index.ts`:
- `fetchMarkets` / `fetchMarket` — thin axios wrappers for `GET /markets` and `GET /markets/{id}`
- `formatVolume`, `formatDate`, `yesPct`, `parsePrices`, `parseOutcomes` — output formatting helpers
- Five tool handlers (`searchMarkets`, `getTrendingMarkets`, `getMarket`, `getMarketsByCategory`, `compareMarkets`) called from a single `CallToolRequestSchema` switch
- `ListToolsRequestSchema` handler declares tool schemas with JSON Schema input validation

**Key constraint:** Nothing must be written to stdout outside of MCP protocol frames — doing so corrupts the stdio stream. All logging goes to `process.stderr`.

## Polymarket API

Base: `https://gamma-api.polymarket.com` — no auth required.

`outcomePrices` and `outcomes` fields are JSON-encoded strings (not arrays), so they must be parsed with `JSON.parse` before use.

## Adding a New Tool

1. Write a `async function myTool(...)` handler that returns a formatted string.
2. Add its JSON Schema entry to the `ListToolsRequestSchema` handler array.
3. Add a `case "my_tool":` branch in the `CallToolRequestSchema` switch.
4. Rebuild with `npm run build`.
