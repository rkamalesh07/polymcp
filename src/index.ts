import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const BASE_URL  = "https://gamma-api.polymarket.com";
const CLOB_URL  = "https://clob.polymarket.com";

// ── Types ────────────────────────────────────────────────────────────────────

interface Market {
  id: string;
  question: string;
  description?: string;
  outcomePrices: string;   // JSON string array, e.g. '["0.73","0.27"]'
  outcomes: string;        // JSON string array, e.g. '["Yes","No"]'
  volume: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  slug?: string;
  conditionId?: string;
}

interface PriceHistoryPoint {
  t: number;   // Unix timestamp (seconds)
  p: number;   // price 0–1
}

interface PriceHistoryResponse {
  history: PriceHistoryPoint[];
}

interface MarketScoreData {
  market: Market;
  yesProb: number;
  volumeNum: number;
  daysRemaining: number;
  sevenDayMove: number | null;
  liquidityScore: number;
  timeScore: number;
  uncertaintyScore: number;
  momentumScore: number;
  total: number;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatVolume(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatDate(iso: string): string {
  if (!iso) return "No end date";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function parsePrices(outcomePrices: string): number[] {
  try {
    const arr = JSON.parse(outcomePrices);
    return arr.map((p: string | number) => parseFloat(String(p)));
  } catch {
    return [];
  }
}

function parseOutcomes(outcomes: string): string[] {
  try {
    return JSON.parse(outcomes);
  } catch {
    return [];
  }
}

function yesPct(outcomePrices: string): string {
  const prices = parsePrices(outcomePrices);
  if (prices.length === 0) return "N/A";
  return `${(prices[0] * 100).toFixed(1)}%`;
}

function formatMarketSummary(m: Market, rank?: number): string {
  const prefix = rank != null ? `${rank}. ` : "• ";
  const pct = yesPct(m.outcomePrices);
  const vol = formatVolume(m.volume);
  const date = formatDate(m.endDate);
  return `${prefix}${m.question}\n   YES: ${pct} | Volume: ${vol} | Ends: ${date}\n   ID: ${m.id}`;
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchMarkets(params: Record<string, string | number | boolean>): Promise<Market[]> {
  const response = await axios.get<Market[]>(`${BASE_URL}/markets`, {
    params,
    timeout: 10_000,
  });
  return response.data;
}

async function fetchMarket(marketId: string): Promise<Market> {
  const response = await axios.get<Market>(`${BASE_URL}/markets/${marketId}`, {
    timeout: 10_000,
  });
  return response.data;
}

async function fetchPriceHistory(conditionId: string): Promise<PriceHistoryPoint[]> {
  const response = await axios.get<PriceHistoryResponse>(
    `${CLOB_URL}/prices-history`,
    {
      params: { market: conditionId, interval: "1w", fidelity: 60 },
      timeout: 5_000,
    }
  );
  return response.data?.history ?? [];
}

// Returns the price change in percentage points over the last 7 days.
function calcSevenDayMove(history: PriceHistoryPoint[]): number | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.t - b.t);
  const nowSec = Date.now() / 1000;
  const sevenDaysAgoSec = nowSec - 7 * 24 * 60 * 60;

  const oldPoint = sorted.reduce((best, p) =>
    Math.abs(p.t - sevenDaysAgoSec) < Math.abs(best.t - sevenDaysAgoSec) ? p : best
  );
  const currentPoint = sorted[sorted.length - 1];
  // Return raw point difference (0-100 scale)
  return (currentPoint.p - oldPoint.p) * 100;
}

// ── Shared scoring logic (used by score_market and generate_trade_thesis) ────

async function computeScore(marketId: string): Promise<MarketScoreData> {
  const m = await fetchMarket(marketId);

  const prices    = parsePrices(m.outcomePrices);
  const yesProb   = prices[0] ?? 0;
  const volumeNum = parseFloat(m.volume) || 0;

  const nowMs        = Date.now();
  const endMs        = m.endDate ? new Date(m.endDate).getTime() : 0;
  const daysRemaining = endMs > nowMs ? Math.ceil((endMs - nowMs) / (1000 * 60 * 60 * 24)) : 0;

  // Liquidity score
  let liquidityScore: number;
  if      (volumeNum >= 1_000_000) liquidityScore = 25;
  else if (volumeNum >= 500_000)   liquidityScore = 20;
  else if (volumeNum >= 100_000)   liquidityScore = 15;
  else if (volumeNum >= 10_000)    liquidityScore = 8;
  else                              liquidityScore = 2;

  // Time score
  let timeScore: number;
  if (!m.endDate || m.closed)      timeScore = 0;
  else if (daysRemaining <= 30)    timeScore = 25;
  else if (daysRemaining <= 90)    timeScore = 20;
  else if (daysRemaining <= 180)   timeScore = 12;
  else                              timeScore = 5;

  // Uncertainty score
  const yesPctNum = yesProb * 100;
  let uncertaintyScore: number;
  if      (yesPctNum >= 40 && yesPctNum <= 60) uncertaintyScore = 25;
  else if ((yesPctNum >= 30 && yesPctNum < 40) || (yesPctNum > 60 && yesPctNum <= 70)) uncertaintyScore = 20;
  else if ((yesPctNum >= 20 && yesPctNum < 30) || (yesPctNum > 70 && yesPctNum <= 80)) uncertaintyScore = 12;
  else uncertaintyScore = 5;

  // Momentum score (7-day price history)
  const conditionId = m.conditionId ?? m.id;
  let sevenDayMove: number | null = null;
  let momentumScore = 10; // neutral when history unavailable

  try {
    const history = await fetchPriceHistory(conditionId);
    sevenDayMove = calcSevenDayMove(history);
    if (sevenDayMove !== null) {
      const absMoved = Math.abs(sevenDayMove);
      if      (absMoved > 15) momentumScore = 25;
      else if (absMoved >= 10) momentumScore = 20;
      else if (absMoved >= 5)  momentumScore = 12;
      else if (absMoved >= 2)  momentumScore = 8;
      else                      momentumScore = 3;
    }
  } catch {
    // history unavailable — neutral score stays at 10
  }

  return {
    market: m,
    yesProb,
    volumeNum,
    daysRemaining,
    sevenDayMove,
    liquidityScore,
    timeScore,
    uncertaintyScore,
    momentumScore,
    total: liquidityScore + timeScore + uncertaintyScore + momentumScore,
  };
}

// ── Tool handlers (original 5) ───────────────────────────────────────────────

async function searchMarkets(query: string, limit = 10): Promise<string> {
  const markets = await fetchMarkets({
    search: query,
    limit,
    active: true,
    closed: false,
  });

  if (!markets || markets.length === 0) {
    return `No active markets found matching "${query}".`;
  }

  const lines = markets.map((m, i) => formatMarketSummary(m, i + 1));
  return `Found ${markets.length} market(s) matching "${query}":\n\n${lines.join("\n\n")}`;
}

async function getTrendingMarkets(limit = 10): Promise<string> {
  const markets = await fetchMarkets({
    limit,
    active: true,
    closed: false,
    order: "volume",
    ascending: false,
  });

  if (!markets || markets.length === 0) {
    return "No trending markets found.";
  }

  const lines = markets.map((m, i) => formatMarketSummary(m, i + 1));
  return `Top ${markets.length} trending markets by volume:\n\n${lines.join("\n\n")}`;
}

async function getMarket(marketId: string): Promise<string> {
  const m = await fetchMarket(marketId);

  if (!m || !m.question) {
    return `Market "${marketId}" not found.`;
  }

  const outcomes = parseOutcomes(m.outcomes);
  const prices   = parsePrices(m.outcomePrices);

  const outcomeLines = outcomes
    .map((outcome, i) => {
      const pct = prices[i] != null ? `${(prices[i] * 100).toFixed(1)}%` : "N/A";
      return `  ${outcome}: ${pct}`;
    })
    .join("\n");

  const description = m.description
    ? `\nDescription: ${m.description.slice(0, 300)}${m.description.length > 300 ? "…" : ""}`
    : "";

  return [
    `Market: ${m.question}`,
    description,
    `\nOutcomes:`,
    outcomeLines,
    `\nVolume:   ${formatVolume(m.volume)}`,
    `Ends:     ${formatDate(m.endDate)}`,
    `Active:   ${m.active ? "Yes" : "No"}`,
    `ID:       ${m.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function getMarketsByCategory(category: string, limit = 10): Promise<string> {
  const validCategories = ["politics", "crypto", "sports", "economics", "science", "entertainment"];
  const normalized = category.toLowerCase().trim();

  if (!validCategories.includes(normalized)) {
    return `Unknown category "${category}". Valid categories: ${validCategories.join(", ")}.`;
  }

  const markets = await fetchMarkets({
    search: normalized,
    limit,
    active: true,
    closed: false,
  });

  if (!markets || markets.length === 0) {
    return `No active ${normalized} markets found.`;
  }

  const lines = markets.map((m, i) => formatMarketSummary(m, i + 1));
  return `${normalized.charAt(0).toUpperCase() + normalized.slice(1)} markets (${markets.length} found):\n\n${lines.join("\n\n")}`;
}

async function compareMarkets(marketIds: string[]): Promise<string> {
  if (marketIds.length < 2 || marketIds.length > 5) {
    return "Please provide between 2 and 5 market IDs to compare.";
  }

  const results = await Promise.allSettled(marketIds.map(fetchMarket));
  const sections: string[] = [];

  results.forEach((result, i) => {
    const id = marketIds[i];
    if (result.status === "rejected") {
      sections.push(`[${i + 1}] ID: ${id}\n    Error: Could not fetch market.`);
      return;
    }

    const m = result.value;
    if (!m || !m.question) {
      sections.push(`[${i + 1}] ID: ${id}\n    Error: Market not found.`);
      return;
    }

    const outcomes   = parseOutcomes(m.outcomes);
    const prices     = parsePrices(m.outcomePrices);
    const outcomeStr = outcomes
      .map((o, idx) => `${o}: ${prices[idx] != null ? (prices[idx] * 100).toFixed(1) + "%" : "N/A"}`)
      .join(" | ");

    sections.push(
      `[${i + 1}] ${m.question}\n    ${outcomeStr}\n    Volume: ${formatVolume(m.volume)} | Ends: ${formatDate(m.endDate)}`
    );
  });

  return `Comparing ${marketIds.length} markets:\n\n${sections.join("\n\n")}`;
}

// ── Tool handlers (new analytical 4) ────────────────────────────────────────

async function detectMomentum(query: string, threshold = 10): Promise<string> {
  const markets = await fetchMarkets({ search: query, limit: 20, active: true, closed: false });

  if (!markets || markets.length === 0) {
    return `No active markets found matching "${query}".`;
  }

  interface MomentumResult {
    market: Market;
    currentPrice: number;
    price7dAgo: number;
    momentumScore: number;
  }

  const results: MomentumResult[] = [];
  const skipped: string[] = [];

  await Promise.allSettled(
    markets.map(async (m) => {
      const conditionId = m.conditionId ?? m.id;
      try {
        const history = await fetchPriceHistory(conditionId);
        if (history.length < 2) {
          skipped.push(m.question);
          return;
        }
        const sorted        = [...history].sort((a, b) => a.t - b.t);
        const nowSec        = Date.now() / 1000;
        const sevenDaysAgo  = nowSec - 7 * 24 * 60 * 60;
        const oldPoint      = sorted.reduce((best, p) =>
          Math.abs(p.t - sevenDaysAgo) < Math.abs(best.t - sevenDaysAgo) ? p : best
        );
        const currentPoint  = sorted[sorted.length - 1];

        // Percentage-change momentum: ((current - old) / old) * 100
        const momentumScore = oldPoint.p !== 0
          ? ((currentPoint.p - oldPoint.p) / oldPoint.p) * 100
          : (currentPoint.p - oldPoint.p) * 100;

        results.push({
          market: m,
          currentPrice: currentPoint.p,
          price7dAgo: oldPoint.p,
          momentumScore,
        });
      } catch {
        skipped.push(m.question);
      }
    })
  );

  // Sort by absolute momentum descending
  results.sort((a, b) => Math.abs(b.momentumScore) - Math.abs(a.momentumScore));

  const highMomentum = results.filter(r => Math.abs(r.momentumScore) >= threshold);
  const lines: string[] = [];

  if (results.length === 0) {
    lines.push(`No price history available for markets matching "${query}".`);
  } else if (highMomentum.length === 0) {
    lines.push(`No markets exceeding momentum threshold (${threshold}) found for "${query}".\n`);
    lines.push("All analyzed markets (ranked by momentum):");
    for (const r of results) {
      const sign = r.momentumScore >= 0 ? "+" : "";
      lines.push(`  • ${r.market.question.slice(0, 80)}`);
      lines.push(`    7-Day Move: ${sign}${r.momentumScore.toFixed(1)}% | Current YES: ${(r.currentPrice * 100).toFixed(1)}%`);
    }
  } else {
    lines.push(`High-momentum markets (|score| ≥ ${threshold}) for "${query}":\n`);
    for (const r of highMomentum) {
      const dir  = r.momentumScore > 0 ? "RISING" : "FALLING";
      const sign = r.momentumScore > 0 ? "+" : "";
      lines.push(r.market.question);
      lines.push(`  Direction:             ${dir}`);
      lines.push(`  7-Day Move:            ${sign}${r.momentumScore.toFixed(1)}%`);
      lines.push(`  Current YES probability: ${(r.currentPrice * 100).toFixed(1)}%`);
      lines.push(`  Volume:                ${formatVolume(r.market.volume)}`);
      lines.push(`  Momentum Score:        ${Math.abs(r.momentumScore).toFixed(1)}`);
      lines.push("");
    }
  }

  if (skipped.length > 0) {
    lines.push(`\nSkipped ${skipped.length} market(s) — price history unavailable.`);
  }

  return lines.join("\n").trim();
}

async function findMispricedMarkets(keywords: string[]): Promise<string> {
  if (keywords.length < 2 || keywords.length > 4) {
    return "Please provide between 2 and 4 keywords.";
  }

  const searchResults = await Promise.allSettled(
    keywords.map(kw => fetchMarkets({ search: kw, limit: 10, active: true, closed: false }))
  );

  const allMarkets: Array<{ market: Market; keyword: string }> = [];

  searchResults.forEach((result, i) => {
    if (result.status === "fulfilled" && result.value) {
      result.value.forEach(m => {
        if (!allMarkets.find(x => x.market.id === m.id)) {
          allMarkets.push({ market: m, keyword: keywords[i] });
        }
      });
    }
  });

  if (allMarkets.length === 0) {
    return "No markets found for the provided keywords.";
  }

  const flagged: string[] = [];

  for (let i = 0; i < allMarkets.length; i++) {
    for (let j = i + 1; j < allMarkets.length; j++) {
      const a      = allMarkets[i];
      const b      = allMarkets[j];
      const pricesA = parsePrices(a.market.outcomePrices);
      const pricesB = parsePrices(b.market.outcomePrices);

      if (pricesA.length === 0 || pricesB.length === 0) continue;

      const pA  = pricesA[0] * 100;
      const pB  = pricesB[0] * 100;
      const gap = Math.abs(pA - pB);

      if (gap > 20) {
        const [low, high] = pA < pB
          ? [{ ...a, pct: pA }, { ...b, pct: pB }]
          : [{ ...b, pct: pB }, { ...a, pct: pA }];

        flagged.push(
          `Market A: ${low.market.question}\n          at ${low.pct.toFixed(1)}% YES` +
          `\nMarket B: ${high.market.question}\n          at ${high.pct.toFixed(1)}% YES` +
          `\nImplied Gap: ${gap.toFixed(1)} percentage points` +
          `\nFlag: POTENTIALLY MISPRICED — ${gap.toFixed(1)}pt spread between related markets suggests inconsistent pricing`
        );
      }
    }
  }

  if (flagged.length === 0) {
    return (
      `No significant mispricings detected among the markets analyzed.\n` +
      `(Analyzed ${allMarkets.length} markets across keywords: ${keywords.join(", ")})`
    );
  }

  const divider = "\n─────────────────────────────────\n";
  return `Found ${flagged.length} potentially mispriced market pair(s):\n\n${flagged.join(divider)}`;
}

async function scoreMarket(marketId: string): Promise<string> {
  const d = await computeScore(marketId);
  const {
    market: m, yesProb, volumeNum, daysRemaining, sevenDayMove,
    liquidityScore, timeScore, uncertaintyScore, momentumScore, total,
  } = d;

  let interpretation: string;
  if      (total >= 75) interpretation = "STRONG OPPORTUNITY";
  else if (total >= 50) interpretation = "MODERATE INTEREST";
  else if (total >= 25) interpretation = "LOW INTEREST";
  else                   interpretation = "AVOID";

  const momentumDetail = sevenDayMove !== null
    ? `${sevenDayMove >= 0 ? "+" : ""}${sevenDayMove.toFixed(1)} point move in 7 days`
    : "history unavailable";

  const timeDetail = m.closed
    ? "already closed"
    : `${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} remaining`;

  const uncertaintyDetail = `${(yesProb * 100).toFixed(1)}% YES${uncertaintyScore === 25 ? " — near coin flip" : ""}`;

  return [
    m.question,
    `Overall Score: ${total}/100 — ${interpretation}`,
    "",
    "Breakdown:",
    `  Liquidity:   ${String(liquidityScore).padStart(2)}/25  (${formatVolume(volumeNum)})`,
    `  Time:        ${String(timeScore).padStart(2)}/25  (${timeDetail})`,
    `  Uncertainty: ${String(uncertaintyScore).padStart(2)}/25  (${uncertaintyDetail})`,
    `  Momentum:    ${String(momentumScore).padStart(2)}/25  (${momentumDetail})`,
    "",
    `Current YES Probability: ${(yesProb * 100).toFixed(1)}%`,
    `Volume: ${formatVolume(volumeNum)}`,
    `Closes: ${formatDate(m.endDate)}`,
    "",
    "Interpretation:",
    "  Score 75-100: STRONG OPPORTUNITY",
    "  Score 50-74:  MODERATE INTEREST",
    "  Score 25-49:  LOW INTEREST",
    "  Score 0-24:   AVOID",
  ].join("\n");
}

async function generateTradeThesis(marketId: string, bankroll = 1000): Promise<string> {
  const d = await computeScore(marketId);
  const {
    market: m, yesProb, volumeNum, daysRemaining, sevenDayMove,
    liquidityScore, timeScore, uncertaintyScore, momentumScore, total,
  } = d;

  // Verdict
  let verdict: string;
  if      (total >= 75 && uncertaintyScore === 25) verdict = "RECOMMENDED TRADE";
  else if (total >= 50)                             verdict = "WATCH — not enough conviction";
  else                                               verdict = "PASS — insufficient opportunity";

  // Direction
  const yesPctNum = yesProb * 100;
  let direction: string;
  let tradeDirection: "YES" | "NO" | "NEUTRAL";
  if      (yesPctNum < 45) { direction = "NO (bet against YES outcome)"; tradeDirection = "NO"; }
  else if (yesPctNum > 55) { direction = "YES";                           tradeDirection = "YES"; }
  else                      { direction = "NEUTRAL — direction unclear";   tradeDirection = "NEUTRAL"; }

  // Quarter-Kelly position sizing
  const edge            = Math.abs(yesProb - 0.5) * 2;
  const kellyFraction   = edge * 0.25;
  const rawPosition     = bankroll * kellyFraction;
  const maxPosition     = bankroll * 0.15;
  const suggestedPos    = Math.min(rawPosition, maxPosition);
  const positionPctStr  = `${(suggestedPos / bankroll * 100).toFixed(1)}%`;

  const positionLine = tradeDirection !== "NEUTRAL"
    ? `Suggested Position: $${suggestedPos.toFixed(2)} (${positionPctStr} of $${bankroll.toLocaleString()} bankroll)`
    : "Suggested Position: N/A (NEUTRAL — no clear directional edge)";

  // Reasoning bullets
  const pros: string[] = [];
  const cons: string[] = [];

  if (liquidityScore >= 20)
    pros.push(`High liquidity (${formatVolume(volumeNum)}) reduces slippage risk`);
  else if (liquidityScore <= 8)
    cons.push(`Low liquidity (${formatVolume(volumeNum)}) increases slippage risk`);

  if (timeScore >= 20)
    pros.push(`Near-term close (${daysRemaining} day${daysRemaining !== 1 ? "s" : ""}) limits time exposure`);
  else if (timeScore <= 5)
    cons.push(`Long time horizon (${daysRemaining} days) increases uncertainty`);

  if (uncertaintyScore === 25)
    pros.push("Near coin-flip probability offers maximum edge potential");
  else if (uncertaintyScore <= 5)
    cons.push("Probability near certainty — limited edge available");

  if (momentumScore >= 20)
    pros.push("Strong momentum signals active repricing");
  else if (momentumScore <= 3)
    cons.push("Low momentum suggests the market hasn't been repriced recently");
  else if (sevenDayMove === null)
    cons.push("No price history available — momentum unknown");

  const reasoningLines = [
    ...pros.map(p => `  + ${p}`),
    ...cons.map(c => `  - ${c}`),
  ];

  const border = "=".repeat(52);

  return [
    border,
    `TRADE THESIS: ${m.question}`,
    border,
    `Verdict:  ${verdict}`,
    "",
    `Direction: ${direction}`,
    `Entry Probability: ${yesPctNum.toFixed(1)}% YES`,
    positionLine,
    "",
    `Score: ${total}/100`,
    "Reasoning:",
    ...reasoningLines,
    "",
    "Risk Note: This is an analytical signal, not financial advice.",
    "Prediction markets carry significant risk of total loss.",
    border,
  ].join("\n");
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "polymcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Original 5 ──────────────────────────────────────────────────────────
    {
      name: "search_markets",
      description: "Search active Polymarket prediction markets by keyword.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term (e.g. 'election', 'bitcoin')" },
          limit: { type: "number", description: "Max results to return (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_trending_markets",
      description: "Get the top active Polymarket markets ranked by trading volume.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of markets to return (default 10)" },
        },
      },
    },
    {
      name: "get_market",
      description: "Get full details for a single Polymarket market by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          market_id: { type: "string", description: "The market condition ID" },
        },
        required: ["market_id"],
      },
    },
    {
      name: "get_markets_by_category",
      description:
        "Get active markets filtered by category. Valid: politics, crypto, sports, economics, science, entertainment.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["politics", "crypto", "sports", "economics", "science", "entertainment"],
            description: "Market category",
          },
          limit: { type: "number", description: "Number of markets to return (default 10)" },
        },
        required: ["category"],
      },
    },
    {
      name: "compare_markets",
      description: "Compare 2–5 Polymarket markets side by side by their IDs.",
      inputSchema: {
        type: "object",
        properties: {
          market_ids: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 5,
            description: "Array of 2–5 market condition IDs",
          },
        },
        required: ["market_ids"],
      },
    },
    // ── New analytical 4 ─────────────────────────────────────────────────────
    {
      name: "detect_momentum",
      description:
        "Search markets by keyword, fetch 7-day price history for each, and rank by momentum score. Flags markets whose probability moved significantly.",
      inputSchema: {
        type: "object",
        properties: {
          query:     { type: "string", description: "Search keyword (e.g. 'election', 'bitcoin')" },
          threshold: { type: "number", description: "Minimum |momentum score| to flag (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "find_mispriced_markets",
      description:
        "Search for related markets using 2–4 keywords, then compare probabilities across all pairs. Flags any pair where the YES probability gap exceeds 20 points.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
            description: "2–4 related search terms to compare across (e.g. ['Fed rate cut June', 'Fed rate cut July'])",
          },
        },
        required: ["keywords"],
      },
    },
    {
      name: "score_market",
      description:
        "Score a single market out of 100 across four dimensions: liquidity, time-to-close, uncertainty, and 7-day momentum.",
      inputSchema: {
        type: "object",
        properties: {
          market_id: { type: "string", description: "The market condition ID" },
        },
        required: ["market_id"],
      },
    },
    {
      name: "generate_trade_thesis",
      description:
        "Generate a structured trade thesis for a market: scores it, recommends direction, sizes a position via quarter-Kelly, and explains the reasoning.",
      inputSchema: {
        type: "object",
        properties: {
          market_id: { type: "string", description: "The market condition ID" },
          bankroll:  { type: "number", description: "Total capital to size from in dollars (default 1000)" },
        },
        required: ["market_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text: string;

    switch (name) {
      // ── Original 5 ────────────────────────────────────────────────────────
      case "search_markets": {
        const { query, limit } = args as { query: string; limit?: number };
        if (!query || typeof query !== "string" || query.trim() === "") {
          return { content: [{ type: "text", text: 'Parameter "query" must be a non-empty string.' }], isError: true };
        }
        text = await searchMarkets(query.trim(), limit ?? 10);
        break;
      }

      case "get_trending_markets": {
        const { limit } = (args ?? {}) as { limit?: number };
        text = await getTrendingMarkets(limit ?? 10);
        break;
      }

      case "get_market": {
        const { market_id } = args as { market_id: string };
        if (!market_id || typeof market_id !== "string" || market_id.trim() === "") {
          return { content: [{ type: "text", text: 'Parameter "market_id" must be a non-empty string.' }], isError: true };
        }
        text = await getMarket(market_id.trim());
        break;
      }

      case "get_markets_by_category": {
        const { category, limit } = args as { category: string; limit?: number };
        if (!category || typeof category !== "string") {
          return { content: [{ type: "text", text: 'Parameter "category" is required.' }], isError: true };
        }
        text = await getMarketsByCategory(category, limit ?? 10);
        break;
      }

      case "compare_markets": {
        const { market_ids } = args as { market_ids: string[] };
        if (!Array.isArray(market_ids) || market_ids.length < 2 || market_ids.length > 5) {
          return { content: [{ type: "text", text: '"market_ids" must be an array of 2–5 strings.' }], isError: true };
        }
        text = await compareMarkets(market_ids);
        break;
      }

      // ── New analytical 4 ──────────────────────────────────────────────────
      case "detect_momentum": {
        const { query, threshold } = args as { query: string; threshold?: number };
        if (!query || typeof query !== "string" || query.trim() === "") {
          return { content: [{ type: "text", text: 'Parameter "query" must be a non-empty string.' }], isError: true };
        }
        text = await detectMomentum(query.trim(), threshold ?? 10);
        break;
      }

      case "find_mispriced_markets": {
        const { keywords } = args as { keywords: string[] };
        if (!Array.isArray(keywords) || keywords.length < 2 || keywords.length > 4) {
          return { content: [{ type: "text", text: '"keywords" must be an array of 2–4 strings.' }], isError: true };
        }
        text = await findMispricedMarkets(keywords);
        break;
      }

      case "score_market": {
        const { market_id } = args as { market_id: string };
        if (!market_id || typeof market_id !== "string" || market_id.trim() === "") {
          return { content: [{ type: "text", text: 'Parameter "market_id" must be a non-empty string.' }], isError: true };
        }
        text = await scoreMarket(market_id.trim());
        break;
      }

      case "generate_trade_thesis": {
        const { market_id, bankroll } = args as { market_id: string; bankroll?: number };
        if (!market_id || typeof market_id !== "string" || market_id.trim() === "") {
          return { content: [{ type: "text", text: 'Parameter "market_id" must be a non-empty string.' }], isError: true };
        }
        text = await generateTradeThesis(market_id.trim(), bankroll ?? 1000);
        break;
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = axios.isAxiosError(err)
      ? `Polymarket API error: ${err.response?.status ?? "network error"} — ${err.message}`
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;

    return { content: [{ type: "text", text: message }], isError: true };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
