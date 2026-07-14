import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  DESTINATION,
  EXPLORER_TX,
  accountFromPrivateKey,
  getUsdcBalance,
  isValidAddress,
  normalizePrivateKey,
  shortAddress,
  transferUsdc,
} from "./lib/arc";

type LogKind = "info" | "ok" | "err";
type Status =
  | "queued"
  | "checking"
  | "claiming"
  | "waiting_funds"
  | "transferring"
  | "done"
  | "error"
  | "skipped";

type WalletJob = {
  id: string;
  privateKey: string;
  address: `0x${string}`;
  status: Status;
  balance: string | null;
  lastTx: string | null;
  error: string | null;
  workerId?: number | null;
};

type WorkerSnap = {
  id: number;
  status: string;
  statusMessage: string;
  busy: boolean;
  lastAddress: string | null;
  lastError: string | null;
  runId: number;
};

type Settings = {
  capsolverKey: string;
  alchemyRpc: string;
  destination: string;
  parallel: number;
  autoTransfer: boolean;
};

const WALLETS_KEY = "arc-faucet-wallets-v4";
const SETTINGS_KEY = "arc-faucet-settings-v1";
const ACTIVE: Status[] = [
  "checking",
  "claiming",
  "waiting_funds",
  "transferring",
];

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        capsolverKey: String(p.capsolverKey || ""),
        alchemyRpc: String(p.alchemyRpc || ""),
        destination: String(p.destination || DESTINATION),
        parallel: Math.max(1, Math.min(30, Number(p.parallel) || 3)),
        autoTransfer: p.autoTransfer !== false,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    capsolverKey: localStorage.getItem("arc-capsolver-key") || "",
    alchemyRpc: "",
    destination: DESTINATION,
    parallel: 3,
    autoTransfer: true,
  };
}

function saveSettingsLocal(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  if (s.capsolverKey) localStorage.setItem("arc-capsolver-key", s.capsolverKey);
}

function loadWallets(): WalletJob[] {
  try {
    const raw = sessionStorage.getItem(WALLETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WalletJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((w) => ({
      ...w,
      status: ACTIVE.includes(w.status) ? "queued" : w.status,
      workerId: null,
    }));
  } catch {
    return [];
  }
}

function saveWallets(list: WalletJob[]) {
  sessionStorage.setItem(WALLETS_KEY, JSON.stringify(list));
}

function parseKeys(text: string) {
  return text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimit(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("limit exceeded") ||
    m.includes("rate limit") ||
    m.includes("rate limited") ||
    m.includes("every 2h") ||
    m.includes("claimed ~") ||
    m.includes("last 2h") ||
    m.includes("too many") ||
    m.includes("faucet limit")
  );
}

export default function App() {
  const initial = loadSettings();
  const [pkInput, setPkInput] = useState("");
  const [wallets, setWallets] = useState<WalletJob[]>(() => loadWallets());
  const [settings, setSettings] = useState<Settings>(initial);
  const [settingsDraft, setSettingsDraft] = useState<Settings>(initial);
  const [logs, setLogs] = useState<
    { id: string; at: string; message: string; kind: LogKind }[]
  >([]);
  const [botOnline, setBotOnline] = useState(false);
  const [workers, setWorkers] = useState<WorkerSnap[]>([]);
  const [cfBan, setCfBan] = useState<{ blocked: boolean; remainingSec?: number } | null>(null);
  const [queueRunning, setQueueRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capBalance, setCapBalance] = useState<number | null>(null);

  const stopRef = useRef(false);
  const walletsRef = useRef(wallets);
  const settingsRef = useRef(settings);
  const runningLock = useRef(false);

  useEffect(() => {
    walletsRef.current = wallets;
  }, [wallets]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const pushLog = useCallback((message: string, kind: LogKind = "info") => {
    setLogs((prev) =>
      [
        { id: `${Date.now()}-${Math.random()}`, at: nowLabel(), message, kind },
        ...prev,
      ].slice(0, 100),
    );
  }, []);

  const patchWallet = useCallback((id: string, patch: Partial<WalletJob>) => {
    const next = walletsRef.current.map((w) =>
      w.id === id ? { ...w, ...patch } : w,
    );
    walletsRef.current = next;
    saveWallets(next);
    setWallets(next);
  }, []);

  // Apply saved settings to bot on load / when online
  const pushConfigToBot = useCallback(async (s: Settings) => {
    if (s.capsolverKey) {
      await fetch(`${API_BASE}/config/capsolver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: s.capsolverKey }),
      }).catch(() => {});
    }
    if (s.alchemyRpc.trim()) {
      await fetch(`${API_BASE}/config/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rpcUrl: s.alchemyRpc.trim() }),
      }).catch(() => {});
      // frontend balance/transfer also uses this when set
      (window as unknown as { __ARC_RPC_URL?: string }).__ARC_RPC_URL =
        s.alchemyRpc.trim();
    }
    await fetch(`${API_BASE}/config/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: s.parallel }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/workers`);
        if (!r.ok) throw new Error("bad");
        const data = await r.json();
        if (!cancelled) {
          setBotOnline(true);
          setWorkers(data.workers || []);
          setCfBan(data.cloudflare || null);
        }
      } catch {
        if (!cancelled) {
          setBotOnline(false);
          setWorkers([]);
        }
      }
    };
    void tick();
    const t = window.setInterval(tick, 500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  // Push saved config once when bot becomes online (not on every settings render)
  const configPushedRef = useRef(false);
  useEffect(() => {
    if (!botOnline) {
      configPushedRef.current = false;
      return;
    }
    if (configPushedRef.current) return;
    configPushedRef.current = true;
    void pushConfigToBot(settingsRef.current);
  }, [botOnline, pushConfigToBot]);

  const stats = useMemo(() => {
    const total = wallets.length;
    const done = wallets.filter((w) => w.status === "done").length;
    const err = wallets.filter((w) => w.status === "error").length;
    const skipped = wallets.filter((w) => w.status === "skipped").length;
    const queued = wallets.filter((w) => w.status === "queued").length;
    const active = wallets.filter((w) => ACTIVE.includes(w.status)).length;
    return { total, done, err, skipped, queued, active };
  }, [wallets]);

  async function saveAllSettings() {
    const next: Settings = {
      ...settingsDraft,
      parallel: Math.max(1, Math.min(30, Number(settingsDraft.parallel) || 1)),
      destination: settingsDraft.destination.trim() || DESTINATION,
      alchemyRpc: settingsDraft.alchemyRpc.trim(),
      capsolverKey: settingsDraft.capsolverKey.trim(),
    };
    if (next.destination && !isValidAddress(next.destination)) {
      pushLog("Invalid destination address", "err");
      return;
    }
    setSaving(true);
    try {
      saveSettingsLocal(next);
      setSettings(next);
      setSettingsDraft(next);
      if (botOnline) {
        await pushConfigToBot(next);
        if (next.capsolverKey) {
          const r = await fetch(`${API_BASE}/config/capsolver`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: next.capsolverKey }),
          });
          const data = await r.json();
          if (typeof data.balance === "number") setCapBalance(data.balance);
        }
      }
      pushLog("Settings saved (browser + bot)", "ok");
    } catch (e) {
      pushLog(e instanceof Error ? e.message : "Save failed", "err");
    } finally {
      setSaving(false);
    }
  }

  function importKeys() {
    const keys = parseKeys(pkInput);
    if (!keys.length) {
      pushLog("Paste private keys (one per line)", "err");
      return;
    }
    const existing = new Set(
      walletsRef.current.map((w) => w.address.toLowerCase()),
    );
    const added: WalletJob[] = [];
    for (const raw of keys) {
      try {
        const pk = normalizePrivateKey(raw);
        const account = accountFromPrivateKey(pk);
        if (existing.has(account.address.toLowerCase())) continue;
        existing.add(account.address.toLowerCase());
        added.push({
          id: `${account.address}-${Date.now()}-${Math.random()}`,
          privateKey: pk,
          address: account.address,
          status: "queued",
          balance: null,
          lastTx: null,
          error: null,
        });
      } catch {
        pushLog(`Invalid key: ${raw.slice(0, 14)}...`, "err");
      }
    }
    if (!added.length) {
      pushLog("No new wallets imported", "err");
      return;
    }
    const next = [...walletsRef.current, ...added];
    walletsRef.current = next;
    saveWallets(next);
    setWallets(next);
    setPkInput("");
    pushLog(`Imported ${added.length} wallet(s)`, "ok");
    for (const w of added) {
      void getUsdcBalance(w.address)
        .then((b) => patchWallet(w.id, { balance: b.formatted }))
        .catch(() => {});
    }
  }

  function removeWallet(id: string) {
    const next = walletsRef.current.filter((w) => w.id !== id);
    walletsRef.current = next;
    saveWallets(next);
    setWallets(next);
  }

  function clearDone() {
    const next = walletsRef.current.filter(
      (w) => w.status !== "done" && w.status !== "skipped",
    );
    walletsRef.current = next;
    saveWallets(next);
    setWallets(next);
  }

  function clearAll() {
    if (queueRunning) {
      pushLog("Stop queue first", "err");
      return;
    }
    walletsRef.current = [];
    saveWallets([]);
    setWallets([]);
  }

  function requeueFailed() {
    const next = walletsRef.current.map((w) =>
      w.status === "error" || w.status === "skipped"
        ? { ...w, status: "queued" as const, error: null, workerId: null }
        : w,
    );
    walletsRef.current = next;
    saveWallets(next);
    setWallets(next);
  }

  async function drainToVault(job: WalletJob): Promise<boolean> {
    const s = settingsRef.current;
    if (!s.autoTransfer) return false;
    if (!isValidAddress(s.destination)) throw new Error("Invalid destination");

    const bal = await getUsdcBalance(job.address);
    patchWallet(job.id, { balance: bal.formatted });
    if (Number(bal.formatted) < 0.15) return false;

    pushLog(
      `[${shortAddress(job.address)}] DRAIN ${bal.formatted} -> ${shortAddress(s.destination)}`,
      "info",
    );

    const { hash, sentFormatted } = await transferUsdc({
      privateKey: job.privateKey,
      to: s.destination as `0x${string}`,
      sendAll: true,
    });
    const after = await getUsdcBalance(job.address).catch(() => null);
    patchWallet(job.id, {
      lastTx: hash,
      balance: after?.formatted ?? "0",
    });
    pushLog(
      `[${shortAddress(job.address)}] SENT ${sentFormatted} · ${hash.slice(0, 14)}...`,
      "ok",
    );
    return true;
  }

  async function claimCheck(address: string) {
    const r = await fetch(`${API_BASE}/claim-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    return (await r.json()) as {
      limited?: boolean;
      amount?: string;
      error?: string;
    };
  }

  async function waitWorkerDone(workerId: number, minRunId: number) {
    const end = Date.now() + 8 * 60_000;
    let sawBusy = false;
    while (Date.now() < end) {
      if (stopRef.current) throw new Error("Queue stopped");
      const r = await fetch(`${API_BASE}/workers/${workerId}`);
      if (!r.ok) throw new Error("Worker poll failed");
      const w = (await r.json()) as WorkerSnap;

      if (
        w.runId >= minRunId &&
        (w.busy ||
          ["running", "solving_captcha", "submitting"].includes(w.status))
      ) {
        sawBusy = true;
      }

      if (sawBusy && !w.busy) {
        if (w.status === "error" || w.lastError) {
          throw new Error(w.lastError || w.statusMessage || "Worker error");
        }
        return w;
      }

      if (
        !w.busy &&
        w.runId >= minRunId &&
        sawBusy &&
        (w.status === "idle" || w.status === "done")
      ) {
        return w;
      }

      if (!w.busy && w.runId >= minRunId && w.status === "error" && w.lastError) {
        throw new Error(w.lastError);
      }

      await sleep(350);
    }
    throw new Error(`Worker ${workerId} timeout`);
  }

  async function processOne(job: WalletJob) {
    const s = settingsRef.current;
    pushLog(`[${shortAddress(job.address)}] start`, "info");

    // 1) Drain existing balance
    try {
      await drainToVault(job);
    } catch (e) {
      pushLog(
        `[${shortAddress(job.address)}] drain: ${e instanceof Error ? e.message : e}`,
        "err",
      );
    }

    // 2) 2h check
    patchWallet(job.id, { status: "checking", error: null });
    try {
      const check = await claimCheck(job.address);
      if (check.limited) {
        try {
          await drainToVault(job);
        } catch {
          /* ignore */
        }
        patchWallet(job.id, {
          status: "skipped",
          error: `2h limit (recent ~${check.amount || "?"} USDC)`,
          workerId: null,
        });
        pushLog(`[${shortAddress(job.address)}] 2h limit -> SKIP`, "info");
        return;
      }
    } catch (e) {
      pushLog(
        `[${shortAddress(job.address)}] check fail, continue: ${e instanceof Error ? e.message : e}`,
        "info",
      );
    }

    // 3) Claim
    patchWallet(job.id, { status: "claiming", error: null });
    const beforeBal = Number(
      (await getUsdcBalance(job.address).catch(() => ({ formatted: "0" })))
        .formatted,
    );

    // Retry start on busy / CF cooldown (do not burn the wallet as permanent error)
    let startRes: Response | null = null;
    let startData: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 8; attempt++) {
      if (stopRef.current) throw new Error("Queue stopped");
      startRes = await fetch(`${API_BASE}/faucet/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: job.address,
          apiKey: s.capsolverKey || undefined,
          skipCheck: true,
        }),
      });
      startData = await startRes.json().catch(() => ({}));

      if (startRes.status === 429 || startData.limited) {
        try {
          await drainToVault(job);
        } catch {
          /* ignore */
        }
        patchWallet(job.id, {
          status: "skipped",
          error: String(startData.error || "Rate limited"),
          workerId: null,
        });
        pushLog(`[${shortAddress(job.address)}] 2h limit -> SKIP`, "info");
        return;
      }

      // Cloudflare IP ban / all busy / stagger: wait and retry
      if (
        startRes.status === 503 ||
        startRes.status === 409 ||
        startData.cloudflare ||
        startData.retryable
      ) {
        // Cap wait so 25-browser runs don't freeze for minutes on each wallet
        const raw = Number(startData.remainingSec) || 3 + attempt * 2;
        const waitSec = Math.min(raw, startData.cloudflare ? 30 : 8);
        pushLog(
          `[${shortAddress(job.address)}] wait ${waitSec}s (${String(startData.error || startRes.status)})`,
          "info",
        );
        await sleep(waitSec * 1000);
        continue;
      }

      if (startRes.ok) break;

      patchWallet(job.id, {
        status: "error",
        error: String(startData.error || `Start failed ${startRes.status}`),
        workerId: null,
      });
      return;
    }

    if (!startRes?.ok) {
      // put back in queue instead of dying
      patchWallet(job.id, {
        status: "queued",
        error: "Waiting for Cloudflare cooldown / free worker",
        workerId: null,
      });
      await sleep(5000);
      return;
    }

    const workerId = Number(startData.workerId);
    const minRunId = Number(startData.runId) || 1;
    patchWallet(job.id, { workerId, status: "claiming" });
    pushLog(
      `[${shortAddress(job.address)}] W${workerId} run #${minRunId}`,
      "info",
    );

    try {
      await waitWorkerDone(workerId, minRunId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await drainToVault(job);
      } catch {
        /* ignore */
      }
      if (isRateLimit(msg)) {
        patchWallet(job.id, {
          status: "skipped",
          error: "Rate limited",
          workerId: null,
        });
        return;
      }
      // Cloudflare / form timeout: re-queue later instead of permanent error
      if (
        /1015|cloudflare|ip rate limited|form not loaded|timeout|context|browser/i.test(
          msg,
        )
      ) {
        patchWallet(job.id, {
          status: "queued",
          error: "temporary - retry",
          workerId: null,
        });
        pushLog(
          `[${shortAddress(job.address)}] re-queued: ${msg.slice(0, 90)}`,
          "info",
        );
        await sleep(2500);
        return;
      }
      patchWallet(job.id, { status: "error", error: msg, workerId: null });
      return;
    }

    pushLog(`[${shortAddress(job.address)}] faucet OK`, "ok");

    // 4) Wait funds (short)
    patchWallet(job.id, { status: "waiting_funds" });
    const pollEnd = Date.now() + 45_000;
    while (Date.now() < pollEnd) {
      if (stopRef.current) {
        patchWallet(job.id, { status: "queued", workerId: null });
        throw new Error("Queue stopped");
      }
      const bal = await getUsdcBalance(job.address);
      patchWallet(job.id, { balance: bal.formatted, status: "waiting_funds" });
      if (
        Number(bal.formatted) >= beforeBal + 0.5 ||
        Number(bal.formatted) >= 1
      ) {
        break;
      }
      await sleep(900);
    }

    // 5) Drain -> done
    patchWallet(job.id, { status: "transferring" });
    try {
      await drainToVault(job);
      const finalBal = await getUsdcBalance(job.address).catch(() => ({
        formatted: "?",
      }));
      patchWallet(job.id, {
        status: "done",
        balance: finalBal.formatted,
        workerId: null,
        error: null,
      });
      pushLog(`[${shortAddress(job.address)}] done`, "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const bal = await getUsdcBalance(job.address).catch(() => null);
      patchWallet(job.id, {
        status: "error",
        error: `transfer: ${msg}`,
        balance: bal?.formatted ?? null,
        workerId: null,
      });
    }
  }

  async function runQueue() {
    if (runningLock.current || queueRunning) return;
    if (!botOnline) {
      pushLog("Bot offline. Run: npm run bot", "err");
      return;
    }
    if (!settings.capsolverKey.trim()) {
      pushLog("Save CapSolver API key first", "err");
      return;
    }
    if (!isValidAddress(settings.destination)) {
      pushLog("Invalid destination", "err");
      return;
    }

    runningLock.current = true;

    // ensure workers
    await fetch(`${API_BASE}/config/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: settings.parallel }),
    }).catch(() => {});

    // reset any stuck active from previous crash back to queued
    {
      const fixed = walletsRef.current.map((w) =>
        ACTIVE.includes(w.status)
          ? { ...w, status: "queued" as const, workerId: null }
          : w,
      );
      walletsRef.current = fixed;
      saveWallets(fixed);
      setWallets(fixed);
    }

    const pending = walletsRef.current.filter((w) => w.status === "queued");
    if (!pending.length) {
      pushLog("No queued wallets", "err");
      runningLock.current = false;
      return;
    }

    stopRef.current = false;
    setQueueRunning(true);
    pushLog(
      `Queue start: ${pending.length} wallets, ${settings.parallel} browsers`,
      "ok",
    );

    // Pass 0: drain all balances first (parallel, independent)
    pushLog("Pass 0: draining existing balances...", "info");
    await Promise.all(
      walletsRef.current.map(async (w) => {
        if (stopRef.current) return;
        if (w.status === "done" || w.status === "skipped") return;
        try {
          await drainToVault(w);
        } catch (e) {
          pushLog(
            `[${shortAddress(w.address)}] pre-drain: ${e instanceof Error ? e.message : e}`,
            "err",
          );
        }
      }),
    );

    // ensure claimable are queued
    {
      const fixed = walletsRef.current.map((w) =>
        ACTIVE.includes(w.status)
          ? { ...w, status: "queued" as const, workerId: null }
          : w,
      );
      walletsRef.current = fixed;
      saveWallets(fixed);
      setWallets(fixed);
    }

    // Atomic pick
    let pickLock = Promise.resolve();
    function pickNext(): WalletJob | null {
      const list = walletsRef.current;
      const next = list.find((w) => w.status === "queued");
      if (!next) return null;
      const updated = list.map((w) =>
        w.id === next.id ? { ...w, status: "checking" as const } : w,
      );
      walletsRef.current = updated;
      saveWallets(updated);
      setWallets(updated);
      return { ...next, status: "checking" };
    }
    async function claimNext(): Promise<WalletJob | null> {
      let job: WalletJob | null = null;
      pickLock = pickLock.then(() => {
        job = pickNext();
      });
      await pickLock;
      return job;
    }

    const concurrency = Math.max(1, Math.min(30, settings.parallel));

    async function workerLoop(slot: number) {
      while (!stopRef.current) {
        const next = await claimNext();
        if (!next) {
          // no queued: wait briefly if others still active, else exit
          const stillActive = walletsRef.current.some((w) =>
            ACTIVE.includes(w.status),
          );
          const stillQueued = walletsRef.current.some(
            (w) => w.status === "queued",
          );
          if (!stillQueued && !stillActive) break;
          if (!stillQueued && stillActive) {
            await sleep(500);
            continue;
          }
          await sleep(300);
          continue;
        }

        pushLog(`[browser ${slot + 1}] -> ${shortAddress(next.address)}`, "info");
        try {
          await processOne(next);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Queue stopped")) {
            patchWallet(next.id, { status: "queued", workerId: null });
            break;
          }
          if (isRateLimit(msg)) {
            try {
              await drainToVault(next);
            } catch {
              /* ignore */
            }
            patchWallet(next.id, {
              status: "skipped",
              error: "Rate limited",
              workerId: null,
            });
          } else {
            try {
              await drainToVault(next);
            } catch {
              /* ignore */
            }
            // only set error if still not terminal
            const cur = walletsRef.current.find((w) => w.id === next.id);
            if (
              cur &&
              cur.status !== "done" &&
              cur.status !== "skipped" &&
              cur.status !== "error"
            ) {
              patchWallet(next.id, {
                status: "error",
                error: msg,
                workerId: null,
              });
            }
            pushLog(`[${shortAddress(next.address)}] ${msg}`, "err");
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, (_, i) => workerLoop(i)),
    );

    // Keep draining the queue until empty (or stop). Never stop early.
    while (!stopRef.current) {
      // put any stuck active back to queued for retry
      const stuck = walletsRef.current.filter((w) => ACTIVE.includes(w.status));
      for (const w of stuck) {
        patchWallet(w.id, { status: "queued", workerId: null, error: null });
      }

      const leftNow = walletsRef.current.filter((w) => w.status === "queued");
      if (!leftNow.length) break;
      pushLog(`Continuing queue: ${leftNow.length} remaining...`, "info");
      await Promise.all(
        Array.from({ length: concurrency }, (_, i) => workerLoop(i)),
      );
    }

    if (stopRef.current) {
      const mid = walletsRef.current.filter((w) => ACTIVE.includes(w.status));
      for (const w of mid) {
        patchWallet(w.id, { status: "queued", workerId: null, error: null });
      }
    }

    setQueueRunning(false);
    runningLock.current = false;
    const final = walletsRef.current;
    const done = final.filter((w) => w.status === "done").length;
    const skipped = final.filter((w) => w.status === "skipped").length;
    const err = final.filter((w) => w.status === "error").length;
    const left = final.filter((w) => w.status === "queued").length;
    if (stopRef.current) {
      pushLog(
        `Stopped. done=${done} skipped=${skipped} error=${err} queued=${left}`,
        "info",
      );
    } else {
      pushLog(
        `Queue finished. done=${done} skipped=${skipped} error=${err} left=${left}`,
        "ok",
      );
    }
  }

  function stopQueue() {
    stopRef.current = true;
    void fetch(`${API_BASE}/faucet/cancel`, { method: "POST" }).catch(() => {});
    pushLog("Stopping after current jobs...", "info");
  }

  const dest = settings.destination;

  return (
    <div className="app">
      <header className="nav">
        <div className="brand">
          <span className="brand-dot" />
          Arc Faucet Claim
        </div>
        <div className="nav-meta">
          <span className={botOnline ? "pill ok" : "pill warn"}>
            bot {botOnline ? "online" : "offline"}
          </span>{" "}
          <span className="pill">
            {settings.parallel} browsers · {stats.active} active · {stats.done}/
            {stats.total} done
            {stats.skipped ? ` · ${stats.skipped} skip` : ""}
            {stats.err ? ` · ${stats.err} err` : ""}
          </span>
        </div>
      </header>

      <main className="main">
        <section className="hero">
          <div className="eyebrow">Arc Testnet</div>
          <h1>Multi-wallet faucet claim and auto-drain</h1>
          <p>
            Import many keys, run up to 30 browsers in parallel, skip 2h
            rate-limits, and send USDC to your vault automatically.
          </p>
        </section>

        <section className="card">
          <div>
            <h2>Settings</h2>
            <p className="card-desc">
              Save once. Values stay in this browser and bot runtime config.
            </p>
          </div>

          <div className="field">
            <label htmlFor="cap">CapSolver API key</label>
            <input
              id="cap"
              className="input mono"
              type="password"
              placeholder="CAP-..."
              value={settingsDraft.capsolverKey}
              onChange={(e) =>
                setSettingsDraft((d) => ({ ...d, capsolverKey: e.target.value }))
              }
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label htmlFor="rpc">Alchemy / Arc RPC URL</label>
            <input
              id="rpc"
              className="input mono"
              placeholder="https://arc-testnet.g.alchemy.com/v2/YOUR_KEY"
              value={settingsDraft.alchemyRpc}
              onChange={(e) =>
                setSettingsDraft((d) => ({ ...d, alchemyRpc: e.target.value }))
              }
              autoComplete="off"
            />
            <div className="hint">
              Used for 2h claim history checks. Public Arc RPC works for
              transfers if left empty.
            </div>
          </div>

          <div className="field">
            <label htmlFor="dest">Destination vault</label>
            <input
              id="dest"
              className="input mono"
              value={settingsDraft.destination}
              onChange={(e) =>
                setSettingsDraft((d) => ({
                  ...d,
                  destination: e.target.value.trim(),
                }))
              }
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label htmlFor="par">Parallel browsers (1 to 30)</label>
            <input
              id="par"
              className="input"
              type="number"
              min={1}
              max={30}
              value={settingsDraft.parallel}
              disabled={queueRunning}
              onChange={(e) =>
                setSettingsDraft((d) => ({
                  ...d,
                  parallel: Math.max(
                    1,
                    Math.min(30, Number(e.target.value) || 1),
                  ),
                }))
              }
              style={{ maxWidth: 120 }}
            />
          </div>

          <label className="pill" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settingsDraft.autoTransfer}
              disabled={queueRunning}
              onChange={(e) =>
                setSettingsDraft((d) => ({
                  ...d,
                  autoTransfer: e.target.checked,
                }))
              }
              style={{ marginRight: 6 }}
            />
            Auto-drain USDC to vault
          </label>

          <div className="row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void saveAllSettings()}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
            {capBalance !== null && (
              <span className="pill ok">CapSolver ${capBalance}</span>
            )}
            {settings.alchemyRpc && (
              <span className="pill ok">RPC saved</span>
            )}
          </div>

          {cfBan?.blocked && (
            <div
              className="alert"
              style={{ borderColor: "rgba(255,107,107,0.45)" }}
            >
              <strong>Cloudflare IP ban (Error 1015).</strong> Circle temporarily
              blocked this IP. Wait ~{cfBan.remainingSec ?? "?"}s. Use 2-4
              parallel browsers (not 25+). Queue will auto-retry.
            </div>
          )}

          {workers.length > 0 && (
            <div className="stats">
              {workers.map((w) => (
                <div className="stat" key={w.id}>
                  <span>
                    W{w.id} {w.busy ? "busy" : "idle"}
                  </span>
                  <strong>
                    {w.status}: {w.statusMessage}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div>
            <h2>Import wallets</h2>
            <p className="card-desc">One private key per line.</p>
          </div>
          <textarea
            className="textarea"
            rows={5}
            placeholder={"0xabc...\n0xdef..."}
            value={pkInput}
            onChange={(e) => setPkInput(e.target.value)}
            spellCheck={false}
          />
          <div className="row">
            <button
              className="btn btn-primary"
              type="button"
              onClick={importKeys}
              disabled={queueRunning}
            >
              Import
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={clearDone}
              disabled={queueRunning}
            >
              Clear done
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={requeueFailed}
              disabled={queueRunning}
            >
              Re-queue failed/skipped
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={clearAll}
              disabled={queueRunning}
            >
              Clear all
            </button>
          </div>
        </section>

        <section className="card">
          <div>
            <h2>Run queue</h2>
            <p className="card-desc">
              Vault: <span className="mono">{shortAddress(dest)}</span>
            </p>
          </div>
          <div className="row">
            <button
              className="btn btn-primary"
              type="button"
              disabled={queueRunning || !botOnline || stats.queued === 0}
              onClick={() => void runQueue()}
            >
              {queueRunning
                ? `Running... ${stats.active} active · ${stats.done}/${stats.total}`
                : `Run queue (${stats.queued}) x ${settings.parallel} browsers`}
            </button>
            <button
              className="btn btn-danger"
              type="button"
              disabled={!queueRunning}
              onClick={stopQueue}
            >
              Stop
            </button>
          </div>
        </section>

        <section className="card">
          <h2 style={{ margin: 0 }}>Wallets ({wallets.length})</h2>
          {wallets.length === 0 ? (
            <p className="card-desc">Import keys first.</p>
          ) : (
            <div className="log" style={{ maxHeight: 420 }}>
              {wallets.map((w, i) => (
                <div className="log-item" key={w.id}>
                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <strong className="mono" style={{ fontSize: 12 }}>
                      #{i + 1} {w.address}
                      {w.workerId ? ` · W${w.workerId}` : ""}
                    </strong>
                    <span
                      className={`pill ${
                        w.status === "done"
                          ? "ok"
                          : w.status === "error"
                            ? "err"
                            : w.status === "skipped"
                              ? "warn"
                              : "warn"
                      }`}
                    >
                      {w.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--mute)" }}>
                    bal: {w.balance ?? "-"}
                    {w.lastTx && (
                      <>
                        {" · "}
                        <a
                          href={`${EXPLORER_TX}${w.lastTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          tx
                        </a>
                      </>
                    )}
                    {w.error && (
                      <span style={{ color: "var(--danger)" }}>
                        {" "}
                        · {w.error}
                      </span>
                    )}
                  </div>
                  {!queueRunning && (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ padding: "4px 8px", fontSize: 12 }}
                        onClick={() =>
                          patchWallet(w.id, {
                            status: "queued",
                            error: null,
                            workerId: null,
                          })
                        }
                      >
                        Re-queue
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ padding: "4px 8px", fontSize: 12 }}
                        onClick={() => void drainToVault(w)}
                      >
                        Drain now
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        style={{ padding: "4px 8px", fontSize: 12 }}
                        onClick={() => removeWallet(w.id)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Activity</h2>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setLogs([])}
            >
              Clear
            </button>
          </div>
          <div className="log">
            {logs.map((item) => (
              <div className="log-item" key={item.id}>
                <time>{item.at}</time>
                <span
                  style={{
                    color:
                      item.kind === "ok"
                        ? "var(--primary-soft)"
                        : item.kind === "err"
                          ? "var(--danger)"
                          : "var(--ink)",
                  }}
                >
                  {item.message}
                </span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        Arc Testnet faucet helper · up to 30 parallel browsers · save your own
        CapSolver + Alchemy keys
      </footer>
    </div>
  );
}
