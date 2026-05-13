# PolyMCP

PolyMCP is a Model Context Protocol (MCP) server that gives AI agents real-time access to [Polymarket](https://polymarket.com) prediction market data — including live probabilities, trading volume, price history, and analytical scoring. Connect it to Claude Code or any MCP-compatible client and start querying, scoring, and building trade theses against live prediction markets. No API key required.

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
claude mcp add polymcp -- node /absolute/path/to/dist/index.js
```

> Replace with your actual path. To get it, run `pwd` from the project root and append `/dist/index.js`.

Verify it's registered:

```bash
claude mcp list
```

---

## Available Tools

### Data Tools

| Tool | Description | Key Inputs |
|------|-------------|------------|
| `search_markets` | Search active markets by keyword | `query`, `limit` |
| `get_trending_markets` | Markets ranked by trading volume | `limit` |
| `get_market` | Full details for a single market | `market_id` |
| `get_markets_by_category` | Markets filtered by category | `category`, `limit` |
| `compare_markets` | Side-by-side comparison of 2–5 markets | `market_ids[]` |

### Analytical Tools

| Tool | Description | Algorithm |
|------|-------------|-----------|
| `detect_momentum` | Rank markets by 7-day price movement | Fetches CLOB price history per market, computes `((current − p7d) / p7d) × 100`, sorts by absolute score, flags markets above a configurable threshold |
| `find_mispriced_markets` | Surface probability inconsistencies across related markets | Searches for each keyword, deduplicates results, compares every market pair — flags any where the YES probability gap exceeds 20 percentage points |
| `score_market` | Multi-factor score out of 100 | Four weighted sub-scores: liquidity (volume tiers), time decay (days to close), uncertainty (distance from 50%), and 7-day momentum from CLOB history |
| `generate_trade_thesis` | Structured trade recommendation with position sizing | Runs `score_market` internally, determines direction from probability, sizes a position using quarter-Kelly criterion capped at 15% of bankroll |

---

## Analytical Engine

PolyMCP does real computational work server-side rather than just proxying API responses. Momentum detection pulls per-market price history from Polymarket's CLOB API — a separate endpoint from the market catalog — and computes percentage-change scores across a rolling 7-day window. Market scoring applies a four-dimensional rubric (liquidity, time decay, uncertainty, and momentum) that penalizes near-certain outcomes and illiquid markets regardless of how interesting the question sounds. Trade thesis generation uses the quarter-Kelly criterion to derive a risk-adjusted position size from the market's edge, capping exposure at 15% of bankroll as a hard safety limit. Together, these tools let an AI agent move from "here are some markets" to "here is a sized, reasoned position" in a single conversation.

---

## Example Agent Workflows

These prompts demonstrate Claude autonomously chaining multiple tools:

**1. Score the most liquid markets and find the best opportunity**
> "Fetch the top 5 markets by volume, run `score_market` on each, and generate a full trade thesis for whichever scores highest."

Claude calls `get_trending_markets`, fans out to `score_market` for each result, identifies the top scorer, then calls `generate_trade_thesis` with a bankroll of your choice.

**2. Momentum scan with mispricing check**
> "Search for election markets, detect momentum across them, and flag any pairs that look mispriced relative to each other."

Claude calls `detect_momentum` with `"election"`, notes which markets are moving, then calls `find_mispriced_markets` with related election keywords to surface probability inconsistencies.

**3. Category deep-dive with opportunity scoring**
> "Pull the top 3 crypto markets and tell me which one has the best opportunity score and why."

Claude calls `get_markets_by_category` with `"crypto"`, then calls `score_market` on each of the top 3, compares the breakdowns, and explains the winner's strongest dimensions.

---

## Example Prompts

1. **"What are the top 10 prediction markets by volume right now?"**
2. **"Search for markets about the 2026 midterm elections and tell me which ones have moved the most."**
3. **"Compare these two markets: [id1] and [id2]"**
4. **"What crypto markets are currently open and which outcome is favored?"**
5. **"Find all economics markets closing before June 2026."**

---

## Technologies

| | |
|---|---|
| **Language** | TypeScript (compiled to Node.js) |
| **Protocol** | MCP SDK (`@modelcontextprotocol/sdk`) — stdio transport |
| **Market Data** | Polymarket Gamma API (`gamma-api.polymarket.com`) |
| **Price History** | Polymarket CLOB API (`clob.polymarket.com`) |
| **HTTP Client** | Axios |

---

## Development

```bash
npm run dev      # run with ts-node (no build step)
npm run build    # compile to dist/
npm start        # run compiled dist/index.js
```

---

*This project is independent and not affiliated with or endorsed by Polymarket.*
