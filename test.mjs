/**
 * End-to-end MCP test — communicates with the server via stdio JSON-RPC,
 * exactly as a real MCP client (Claude Code) would.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const SERVER = "node";
const SERVER_ARGS = ["dist/index.js"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(proc, msg) {
  const line = JSON.stringify(msg) + "\n";
  proc.stdin.write(line);
}

function waitForId(rl, id, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for id=${id}`)), timeoutMs);
    rl.on("line", function handler(line) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          clearTimeout(timer);
          rl.removeListener("line", handler);
          resolve(msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    });
  });
}

async function callTool(proc, rl, id, name, args = {}) {
  send(proc, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return waitForId(rl, id);
}

function extractText(response) {
  return response?.result?.content?.[0]?.text ?? JSON.stringify(response?.error ?? response);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const proc = spawn(SERVER, SERVER_ARGS, {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", (d) => process.stderr.write("[server stderr] " + d));

const rl = createInterface({ input: proc.stdout });

// 1. Initialize
send(proc, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "polymcp-test", version: "1.0" },
  },
});
await waitForId(rl, 1);

// Notify initialized
send(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("=".repeat(70));

// Step 1: get_trending_markets
console.log("\n[STEP 1] get_trending_markets (limit: 5)\n");
const t1 = await callTool(proc, rl, 2, "get_trending_markets", { limit: 5 });
const trending = extractText(t1);
console.log(trending);

// Extract first two market IDs from the result
const idMatches = [...trending.matchAll(/ID:\s*([^\n]+)/g)];
const id1 = idMatches[0]?.[1]?.trim();
const id2 = idMatches[1]?.[1]?.trim();
console.log(`\n→ Captured ID #1: ${id1}`);
console.log(`→ Captured ID #2: ${id2}`);
console.log("\n" + "=".repeat(70));

// Step 2: search_markets
console.log("\n[STEP 2] search_markets (query: 'Trump', limit: 5)\n");
const t2 = await callTool(proc, rl, 3, "search_markets", { query: "Trump", limit: 5 });
console.log(extractText(t2));
console.log("\n" + "=".repeat(70));

// Step 3: get_markets_by_category
console.log("\n[STEP 3] get_markets_by_category (category: 'crypto', limit: 5)\n");
const t3 = await callTool(proc, rl, 4, "get_markets_by_category", { category: "crypto", limit: 5 });
console.log(extractText(t3));
console.log("\n" + "=".repeat(70));

// Step 4: get_market (first ID from step 1)
console.log(`\n[STEP 4] get_market (id: ${id1})\n`);
if (id1) {
  const t4 = await callTool(proc, rl, 5, "get_market", { market_id: id1 });
  console.log(extractText(t4));
} else {
  console.log("SKIP — no ID captured from step 1");
}
console.log("\n" + "=".repeat(70));

// Step 5: compare_markets (first two IDs from step 1)
console.log(`\n[STEP 5] compare_markets (ids: [${id1}, ${id2}])\n`);
if (id1 && id2) {
  const t5 = await callTool(proc, rl, 6, "compare_markets", { market_ids: [id1, id2] });
  console.log(extractText(t5));
} else {
  console.log("SKIP — fewer than 2 IDs captured from step 1");
}
console.log("\n" + "=".repeat(70));

proc.kill();
console.log("\nAll tests complete.\n");
