import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const BASE_URL = "https://gamma-api.polymarket.com";

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

// ── Tool handlers ────────────────────────────────────────────────────────────

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
  const prices = parsePrices(m.outcomePrices);

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

    const outcomes = parseOutcomes(m.outcomes);
    const prices = parsePrices(m.outcomePrices);
    const outcomeStr = outcomes
      .map((o, idx) => `${o}: ${prices[idx] != null ? (prices[idx] * 100).toFixed(1) + "%" : "N/A"}`)
      .join(" | ");

    sections.push(
      `[${i + 1}] ${m.question}\n    ${outcomeStr}\n    Volume: ${formatVolume(m.volume)} | Ends: ${formatDate(m.endDate)}`
    );
  });

  return `Comparing ${marketIds.length} markets:\n\n${sections.join("\n\n")}`;
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "polymcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text: string;

    switch (name) {
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
  // Server runs on stdio — no console output here to avoid corrupting the MCP stream
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
