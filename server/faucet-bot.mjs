/**
 * Parallel faucet worker pool + claim-check + CapSolver config.
 * Each worker = independent Chrome window.
 */
import cors from "cors";
import express from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCapsolverBalance } from "./capsolver.mjs";
import { checkRecentFaucetClaim } from "./claim-check.mjs";
import { FaucetWorker, shutdownSharedBrowser } from "./worker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
/** Runtime config (NOT .env) so Vite does not restart on every save */
const CONFIG_PATH = join(__dirname, "runtime-config.json");
const ENV_PATH = join(ROOT, ".env");

function loadEnvFile() {
  // optional .env for initial secrets (read-only; bot never writes this)
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvFile();

function loadRuntimeConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function persistRuntimeConfig(patch) {
  const cur = loadRuntimeConfig();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

// Apply saved runtime config once at boot
{
  const cfg = loadRuntimeConfig();
  if (cfg.CAPSOLVER_API_KEY) process.env.CAPSOLVER_API_KEY = cfg.CAPSOLVER_API_KEY;
  if (cfg.ARC_RPC_URL) process.env.ARC_RPC_URL = cfg.ARC_RPC_URL;
}

const PORT = 8787;
const DEFAULT_RPC =
  process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";

let runtimeCapsolverKey = process.env.CAPSOLVER_API_KEY || "";
let rpcUrl = DEFAULT_RPC;
/** @type {FaucetWorker[]} */
let workers = [];
let recentLogs = [];
/** Global Cloudflare ban cooldown (ms timestamp) */
let cfBlockedUntil = 0;
let lastStartAt = 0;
/** Min gap between starting claims (ms) to reduce CF 1015 */
const START_STAGGER_MS = 1200;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  recentLogs = [line, ...recentLogs].slice(0, 60);
  console.log(`[pool] ${msg}`);
}

function getApiKey() {
  return (runtimeCapsolverKey || process.env.CAPSOLVER_API_KEY || "").trim();
}

function markCloudflareBan(minutes = 8) {
  // Soft cooldown: don't freeze the whole queue for too long
  const until = Date.now() + minutes * 60_000;
  if (until > cfBlockedUntil) {
    cfBlockedUntil = until;
    log(
      `Cloudflare cooldown until ${new Date(cfBlockedUntil).toLocaleTimeString()} (${minutes}m)`,
    );
  }
}

function cloudflareStatus() {
  const now = Date.now();
  if (now >= cfBlockedUntil) {
    return { blocked: false, remainingSec: 0 };
  }
  return {
    blocked: true,
    remainingSec: Math.ceil((cfBlockedUntil - now) / 1000),
    until: cfBlockedUntil,
  };
}

function ensureWorkers(n) {
  const count = Math.max(1, Math.min(30, Number(n) || 1));
  while (workers.length < count) {
    const id = workers.length + 1;
    const w = new FaucetWorker(id, (m) => {
      recentLogs = [m, ...recentLogs].slice(0, 60);
      console.log(m);
      if (/1015|cloudflare|ip rate limited/i.test(m)) {
        markCloudflareBan(15);
      }
    });
    workers.push(w);
    log(`worker ${id} created`);
  }
  while (workers.length > count) {
    const w = workers.pop();
    void w.shutdown();
    log(`worker ${w.id} removed`);
  }
  return workers.length;
}

function poolSnapshot() {
  const cf = cloudflareStatus();
  return {
    workers: workers.map((w) => w.snapshot()),
    workerCount: workers.length,
    busyCount: workers.filter((w) => w.busy).length,
    hasCapsolverKey: Boolean(getApiKey()),
    rpcUrl: rpcUrl.replace(/\/v2\/.*/, "/v2/***"),
    cloudflare: cf,
    logs: recentLogs.slice(0, 20),
  };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "64kb" }));

// default 1 worker
ensureWorkers(1);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...poolSnapshot() });
});

app.get("/status", (_req, res) => {
  // Aggregate for UI
  const busy = workers.filter((w) => w.busy);
  const anyError = workers.find((w) => w.status === "error" && w.lastError);
  let status = "idle";
  let statusMessage = "Ready";
  if (busy.length) {
    status = busy[0].status;
    statusMessage = `${busy.length} worker(s) busy · ${busy[0].statusMessage}`;
  } else if (anyError) {
    status = "idle";
    statusMessage = `Last error on W${anyError.id}: ${anyError.lastError}`;
  }

  res.json({
    status,
    statusMessage,
    lastAddress: busy[0]?.lastAddress || workers[0]?.lastAddress || null,
    lastError: anyError?.lastError || null,
    hasCapsolverKey: Boolean(getApiKey()),
    browserOpen: workers.some((w) => w.context),
    runId: workers.reduce((m, w) => Math.max(m, w.runId), 0),
    lastFinishedRunId: workers.reduce((m, w) => Math.max(m, w.runId), 0),
    ...poolSnapshot(),
  });
});

app.post("/config/workers", async (req, res) => {
  const n = Number(req.body?.count) || 1;
  const count = ensureWorkers(n);
  // Pre-warm a few contexts so first wave starts together (not one-by-one forever)
  const warm = Math.min(count, 6);
  res.json({ ok: true, workerCount: count, warming: warm });
  // fire-and-forget warm so HTTP returns fast
  void (async () => {
    for (let i = 0; i < warm; i++) {
      try {
        if (!workers[i].busy) await workers[i].ensureContext();
      } catch (e) {
        log(`warm W${workers[i].id}: ${e instanceof Error ? e.message : e}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
});

app.post("/config/capsolver", async (req, res) => {
  const key = String(req.body?.apiKey || "").trim();
  if (!key) return res.status(400).json({ error: "apiKey required" });
  runtimeCapsolverKey = key;
  process.env.CAPSOLVER_API_KEY = key;
  try {
    persistRuntimeConfig({ CAPSOLVER_API_KEY: key });
  } catch {
    /* ignore */
  }
  try {
    const bal = await getCapsolverBalance(key);
    res.json({
      ok: true,
      balance: bal.balance,
      errorId: bal.errorId,
      errorDescription: bal.errorDescription,
    });
  } catch (e) {
    res.json({
      ok: true,
      saved: true,
      balanceCheckError: e instanceof Error ? e.message : String(e),
    });
  }
});

app.get("/config/capsolver", async (_req, res) => {
  const key = getApiKey();
  if (!key) return res.json({ hasKey: false });
  try {
    const bal = await getCapsolverBalance(key);
    res.json({ hasKey: true, balance: bal.balance });
  } catch (e) {
    res.json({
      hasKey: true,
      balanceCheckError: e instanceof Error ? e.message : String(e),
    });
  }
});

app.post("/config/rpc", (req, res) => {
  const url = String(req.body?.rpcUrl || "").trim();
  if (!url.startsWith("http")) {
    return res.status(400).json({ error: "Valid rpcUrl required" });
  }
  rpcUrl = url;
  process.env.ARC_RPC_URL = url;
  try {
    persistRuntimeConfig({ ARC_RPC_URL: url });
  } catch {
    /* ignore */
  }
  res.json({ ok: true });
});

/** Pre-check 2h rate limit via Alchemy */
app.post("/claim-check", async (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  try {
    const result = await checkRecentFaucetClaim(rpcUrl, address);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      limited: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/**
 * Start claim on a free worker.
 * Body: { address, apiKey?, workerId? }
 * Returns immediately with { workerId, runId }; poll /workers/:id
 */
app.post("/faucet/start", async (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (req.body?.apiKey) {
    runtimeCapsolverKey = String(req.body.apiKey).trim();
    process.env.CAPSOLVER_API_KEY = runtimeCapsolverKey;
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Valid 0x address required" });
  }
  if (!getApiKey()) {
    return res.status(400).json({ error: "CapSolver API key required" });
  }

  // Global Cloudflare IP ban cooldown
  const cf = cloudflareStatus();
  if (cf.blocked) {
    return res.status(503).json({
      error: `Cloudflare IP ban active. Wait ~${cf.remainingSec}s then lower parallel browsers (try 2-4).`,
      cloudflare: true,
      remainingSec: cf.remainingSec,
      retryable: true,
    });
  }

  // optional pre-check
  if (req.body?.skipCheck !== true) {
    try {
      const check = await checkRecentFaucetClaim(rpcUrl, address);
      if (check.limited) {
        return res.status(429).json({
          error: `Rate limited: claimed ~${check.amount || "?"} USDC in last 2h`,
          limited: true,
          ...check,
        });
      }
    } catch (e) {
      log(`claim-check fail: ${e instanceof Error ? e.message : e}`);
    }
  }

  let worker = null;
  if (req.body?.workerId) {
    worker = workers.find((w) => w.id === Number(req.body.workerId));
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    if (worker.busy) return res.status(409).json({ error: "Worker busy" });
  } else {
    worker = workers.find((w) => !w.busy);
    if (!worker) {
      return res.status(409).json({
        error: "All workers busy",
        workerCount: workers.length,
        busyCount: workers.filter((w) => w.busy).length,
        retryable: true,
      });
    }
  }

  // Stagger starts so N browsers do not hit CF at the same second
  const wait = Math.max(0, START_STAGGER_MS - (Date.now() - lastStartAt));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  // re-check CF after wait
  const cf2 = cloudflareStatus();
  if (cf2.blocked) {
    return res.status(503).json({
      error: `Cloudflare IP ban active. Wait ~${cf2.remainingSec}s.`,
      cloudflare: true,
      remainingSec: cf2.remainingSec,
      retryable: true,
    });
  }
  if (worker.busy) {
    return res.status(409).json({ error: "Worker became busy", retryable: true });
  }

  lastStartAt = Date.now();
  const runId = worker.runId + 1;
  res.json({
    ok: true,
    workerId: worker.id,
    runId,
  });

  worker.run(address, getApiKey()).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    log(`W${worker.id} failed: ${msg}`);
    if (/1015|cloudflare|ip rate limited|banned you temporarily/i.test(msg)) {
      markCloudflareBan(15);
    }
  });
});

app.get("/workers", (_req, res) => {
  res.json(poolSnapshot());
});

app.get("/workers/:id", (req, res) => {
  const w = workers.find((x) => x.id === Number(req.params.id));
  if (!w) return res.status(404).json({ error: "not found" });
  res.json(w.snapshot());
});

app.post("/faucet/cancel", async (req, res) => {
  const id = req.body?.workerId;
  if (id) {
    const w = workers.find((x) => x.id === Number(id));
    if (w) await w.cancel();
  } else {
    await Promise.all(workers.map((w) => w.cancel()));
  }
  res.json({ ok: true });
});

app.post("/faucet/shutdown-browser", async (_req, res) => {
  await Promise.all(workers.map((w) => w.shutdown()));
  await shutdownSharedBrowser();
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  log(`http://127.0.0.1:${PORT}`);
  log(`CapSolver: ${getApiKey() ? "YES" : "NO"}`);
  log(`RPC: ${rpcUrl.slice(0, 50)}…`);
  log(`Workers: ${workers.length}`);
});

process.on("SIGINT", async () => {
  await Promise.all(workers.map((w) => w.shutdown()));
  await shutdownSharedBrowser();
  process.exit(0);
});
