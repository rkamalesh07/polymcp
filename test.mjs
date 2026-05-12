/**
 * End-to-end MCP test — communicates with the server via stdio JSON-RPC.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const proc = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", (d) => process.stderr.write("[server stderr] " + d));

const rl = createInterface({ input: proc.stdout });

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function waitForId(id, timeoutMs = 20_000) {
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
      } catch { /* skip non-JSON */ }
    });
  });
}

async function callTool(id, name, args = {}) {
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return waitForId(id);
}

function text(response) {
  return response?.result?.content?.[0]?.text ?? JSON.stringify(response?.error ?? response);
}

// ── Handshake ────────────────────────────────────────────────────────────────

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "polymcp-test", version: "1.0" },
  },
});
await waitForId(1);
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

// ── Confirm all 9 tools are registered ───────────────────────────────────────

send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const listResp = await waitForId(2);
const toolNames = listResp?.result?.tools?.map(t => t.name) ?? [];
console.log(`\nRegistered tools (${toolNames.length}):`);
toolNames.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

if (toolNames.length !== 9) {
  console.error(`\nERROR: expected 9 tools, got ${toolNames.length}`);
  proc.kill(); process.exit(1);
}
console.log("\n✓ All 9 tools registered\n");

// ── Step 1: get a live market ID from trending ────────────────────────────────

console.log("=".repeat(60));
console.log("[SETUP] Fetching a live market ID from get_trending_markets…\n");
const trendResp = await callTool(3, "get_trending_markets", { limit: 5 });
const trendText = text(trendResp);
console.log(trendText);

const idMatches = [...trendText.matchAll(/ID:\s*([^\n]+)/g)];
const testId = idMatches[0]?.[1]?.trim();
if (!testId) {
  console.error("Could not extract a market ID from trending results.");
  proc.kill(); process.exit(1);
}
console.log(`\n→ Using market ID: ${testId}`);

// ── Step 2: score_market ──────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`[TEST] score_market  (id: ${testId})\n`);
const scoreResp = await callTool(4, "score_market", { market_id: testId });
console.log(text(scoreResp));

// ── Step 3: generate_trade_thesis ─────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`[TEST] generate_trade_thesis  (id: ${testId}, bankroll: $1000)\n`);
const thesisResp = await callTool(5, "generate_trade_thesis", { market_id: testId, bankroll: 1000 });
console.log(text(thesisResp));

console.log("\n" + "=".repeat(60));
console.log("All tests passed.\n");

proc.kill();
