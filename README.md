# PolyMCP

PolyMCP is a Model Context Protocol (MCP) server that gives AI agents real-time access to [Polymarket](https://polymarket.com) prediction market data. Connect it to Claude Code or any MCP-compatible client and start querying live market probabilities, trading volumes, and outcomes — no API key required.

---

## Installation

```bash
npm install
npm run build
```

This compiles TypeScript to `dist/index.js`.

---

## Connect to Claude Code

```bash
claude mcp add polymcp -- node /Users/rishab/Downloads/polymcp/dist/index.js
```

Verify it's registered:

```bash
claude mcp list
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| `search_markets` | Search active markets by keyword |
| `get_trending_markets` | Top markets ranked by trading volume |
| `get_market` | Full details for a single market by ID |
| `get_markets_by_category` | Markets filtered by category (politics, crypto, sports, economics, science, entertainment) |
| `compare_markets` | Side-by-side comparison of 2–5 markets |

---

## Example Prompts

1. **"What are the top 10 prediction markets by volume right now?"**
   Uses `get_trending_markets` to surface the highest-activity markets, then interprets what they signal about current collective attention.

2. **"Search for markets about the 2026 midterm elections and tell me which ones have moved the most."**
   Uses `search_markets` with query `"2026 midterm"` to find relevant markets, then reasons about which probabilities suggest the highest uncertainty or recent movement.

3. **"Compare these two markets: [id1] and [id2]"**
   Uses `compare_markets` to fetch both markets in parallel and present a structured side-by-side breakdown of probabilities, volume, and timelines.

4. **"What crypto markets are currently open and which outcome is favored?"**
   Uses `get_markets_by_category` with `"crypto"` to list active markets, then identifies the leading outcome in each based on current probabilities.

5. **"Find all economics markets closing before June 2026."**
   Uses `get_markets_by_category` with `"economics"`, then filters results by end date to highlight markets with near-term resolution.

---

## Development

```bash
npm run dev      # run with ts-node (no build step)
npm run build    # compile to dist/
npm start        # run compiled dist/index.js
```

---

*This project is independent and not affiliated with or endorsed by Polymarket.*
