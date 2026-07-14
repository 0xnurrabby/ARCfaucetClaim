/**
 * One worker = one separate Chrome window (persistent profile).
 * Browsers open one-by-one via a launch queue; after open they work in parallel.
 */
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solveRecaptchaV2, orderSiteKeys } from "./capsolver.mjs";
import { injectRecaptchaToken } from "./recaptcha-inject.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FAUCET_URL = "https://faucet.circle.com/";
const FALLBACK_SITEKEYS = [
  "6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve",
  "6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2",
];
const INVIS_KEY = FALLBACK_SITEKEYS[1];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Open browsers one-by-one (not all at once) */
let launchChain = Promise.resolve();
function queueLaunch(fn) {
  const run = launchChain.then(fn, fn);
  // keep chain alive even if one launch fails
  launchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function shutdownSharedBrowser() {
  // no shared browser
}

export class FaucetWorker {
  /**
   * @param {number} id
   * @param {(msg: string) => void} onLog
   */
  constructor(id, onLog = () => {}) {
    this.id = id;
    this.onLog = onLog;
    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    this.status = "idle";
    this.statusMessage = "Ready";
    this.lastAddress = null;
    this.lastError = null;
    this.busy = false;
    this.runId = 0;
    this.logs = [];
    this._onReq = null;
    this._onRes = null;
    this._launching = false;
  }

  log(msg) {
    const line = `[W${this.id} ${new Date().toLocaleTimeString()}] ${msg}`;
    this.logs = [line, ...this.logs].slice(0, 25);
    this.onLog(line);
  }

  setStatus(s, m) {
    this.status = s;
    this.statusMessage = m;
    this.log(`${s}: ${m}`);
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      statusMessage: this.statusMessage,
      lastAddress: this.lastAddress,
      lastError: this.lastError,
      busy: this.busy,
      runId: this.runId,
      logs: this.logs.slice(0, 10),
    };
  }

  detachPageListeners() {
    if (!this.page) return;
    try {
      if (this._onReq) this.page.off("request", this._onReq);
      if (this._onRes) this.page.off("response", this._onRes);
    } catch {
      /* ignore */
    }
    this._onReq = null;
    this._onRes = null;
  }

  isContextAlive() {
    if (!this.context) return false;
    try {
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Separate Chrome window per worker.
   * Launch is queued globally so windows open 1,2,3... not all at once.
   */
  async ensureBrowser() {
    if (this.isContextAlive()) {
      try {
        if (this.page && !this.page.isClosed()) return;
        this.page = this.context.pages()[0] || (await this.context.newPage());
        return;
      } catch {
        /* recreate below */
      }
    }

    if (this._launching) {
      // wait until current launch finishes
      while (this._launching) await sleep(100);
      if (this.isContextAlive() && this.page && !this.page.isClosed()) return;
    }

    await this.resetBrowser();

    this._launching = true;
    try {
      await queueLaunch(async () => {
        this.setStatus("running", `Opening browser #${this.id}…`);
        const profile = join(ROOT, `.browser-profile-w${this.id}`);
        const col = ((this.id - 1) % 5) * 36;
        const row = Math.floor((this.id - 1) / 5) * 36;
        const args = [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage",
          `--window-position=${24 + col},${24 + row}`,
          "--window-size=1180,820",
        ];

        try {
          this.context = await chromium.launchPersistentContext(profile, {
            channel: "chrome",
            headless: false,
            viewport: null,
            locale: "en-US",
            args,
            ignoreDefaultArgs: ["--enable-automation"],
            userAgent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          });
        } catch {
          this.context = await chromium.launchPersistentContext(profile, {
            headless: false,
            viewport: null,
            locale: "en-US",
            args,
            ignoreDefaultArgs: ["--enable-automation"],
          });
        }

        this.context.on("close", () => {
          this.context = null;
          this.page = null;
        });

        await this.context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
          // @ts-ignore
          window.chrome = { runtime: {} };
        });

        for (const p of this.context.pages().slice(1)) {
          await p.close().catch(() => {});
        }
        this.page = this.context.pages()[0] || (await this.context.newPage());
        this.page.setDefaultTimeout(15000);
        this.log(`browser #${this.id} open`);
        // gap between window opens
        await sleep(500);
      });
    } finally {
      this._launching = false;
    }
  }

  async ensureContext() {
    return this.ensureBrowser();
  }

  async resetBrowser() {
    this.detachPageListeners();
    try {
      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
    } catch {
      /* ignore */
    }
    this.page = null;
    this.context = null;
  }

  async detectCloudflareBlock() {
    try {
      const info = await this.page.evaluate(() => {
        const t = (document.body?.innerText || "").toLowerCase();
        const title = (document.title || "").toLowerCase();
        return {
          has1015: t.includes("error 1015") || t.includes("1015"),
          rateLimited:
            t.includes("you are being rate limited") ||
            t.includes("access denied") ||
            t.includes("banned you temporarily") ||
            title.includes("access denied"),
        };
      });
      if (info.has1015 || info.rateLimited) {
        return {
          blocked: true,
          message:
            "Cloudflare Error 1015: IP rate limited. Lower parallel and wait.",
        };
      }
      return { blocked: false };
    } catch {
      return { blocked: false };
    }
  }

  /**
   * Wait until wallet form is visible (poll fast — start work the moment page is ready).
   * @param {number} maxMs
   */
  async waitForFormReady(maxMs = 12000) {
    const end = Date.now() + maxMs;
    const addressInput = this.page
      .getByPlaceholder(/wallet address/i)
      .or(this.page.locator('input[placeholder*="address" i]'))
      .first();
    while (Date.now() < end) {
      if (this.page.isClosed()) return false;
      const cf = await this.detectCloudflareBlock();
      if (cf.blocked) return false;
      try {
        if (await addressInput.isVisible().catch(() => false)) {
          // Send button may appear a tick later — don't block long
          await this.sendBtn()
            .waitFor({ state: "visible", timeout: 2000 })
            .catch(() => {});
          return true;
        }
      } catch {
        /* keep polling */
      }
      await sleep(150);
    }
    return false;
  }

  /**
   * Load faucet page. On CF 1015 / blank: refresh and keep trying.
   * As soon as form appears → return immediately (no stuck waiting).
   */
  async openFaucet() {
    await this.ensureBrowser();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }

    let attempt = 0;
    while (true) {
      attempt += 1;
      this.setStatus(
        "running",
        attempt === 1 ? "Opening faucet…" : `Refresh #${attempt}…`,
      );

      try {
        // commit = return as soon as navigation starts loading (faster than full load)
        await this.page.goto(FAUCET_URL, {
          waitUntil: "commit",
          timeout: 30000,
        });
      } catch (e) {
        this.log(`goto fail — retry: ${e instanceof Error ? e.message : e}`);
        await sleep(600);
        continue;
      }

      // Poll: the moment form is there, go work (don't sit idle)
      const ready = await this.waitForFormReady(10000);
      if (ready) {
        this.log("form ready — starting claim");
        return;
      }

      const cf = await this.detectCloudflareBlock();
      if (cf.blocked) {
        this.log(`CF/rate page — hard refresh #${attempt}`);
      } else {
        this.log(`form not ready — hard refresh #${attempt}`);
      }

      try {
        await this.page.goto(FAUCET_URL, {
          waitUntil: "commit",
          timeout: 30000,
        });
      } catch {
        try {
          await this.page.reload({ waitUntil: "commit", timeout: 20000 });
        } catch {
          /* loop */
        }
      }
      await sleep(400);
    }
  }

  sendBtn() {
    return this.page
      .getByRole("button", { name: /Send\s+\d+\s*USDC/i })
      .or(this.page.locator("button").filter({ hasText: /Send\s+\d+\s*USDC/i }))
      .first();
  }

  async fillForm(address) {
    const p = this.page;
    try {
      await p
        .getByRole("button", { name: /^USDC$/i })
        .or(p.locator("button").filter({ hasText: /^USDC$/ }))
        .first()
        .click({ timeout: 1500 });
    } catch {
      /* ok */
    }

    try {
      const netText = await p
        .locator("label:has-text('Network')")
        .locator("..")
        .innerText({ timeout: 800 })
        .catch(() => "");
      if (!/Arc Testnet/i.test(netText)) {
        await p
          .locator("label:has-text('Network')")
          .locator("..")
          .locator('button, [role="combobox"]')
          .first()
          .or(p.getByRole("combobox").first())
          .click({ timeout: 1500 });
        await p
          .getByRole("option", { name: /Arc Testnet/i })
          .or(p.locator('[role="option"], li').filter({ hasText: /Arc Testnet/i }))
          .first()
          .click({ timeout: 1500 });
      }
    } catch {
      /* ok */
    }

    const input = p
      .getByPlaceholder(/wallet address/i)
      .or(p.locator('input[placeholder*="address" i]'))
      .first();
    await input.fill(address);
    await input.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, address);
  }

  async extractSiteKeys(networkKeys) {
    const dom = await this.page.evaluate(() => {
      const out = [];
      document.querySelectorAll("[data-sitekey]").forEach((el) => {
        const k = el.getAttribute("data-sitekey");
        if (k) out.push(k);
      });
      document.querySelectorAll("iframe[src*='recaptcha']").forEach((el) => {
        try {
          const k = new URL(el.src).searchParams.get("k");
          if (k) out.push(k);
        } catch {
          /* ignore */
        }
      });
      const m =
        document.documentElement.innerHTML.match(/6L[A-Za-z0-9_-]{35,}/g) || [];
      return [...new Set([...out, ...m])];
    });
    return orderSiteKeys([...(networkKeys || []), ...dom, ...FALLBACK_SITEKEYS]);
  }

  /**
   * Full claim attempt. On CF / captcha / network fail: refresh page and retry
   * forever until success or permanent 2h wallet limit.
   * @param {string} address
   * @param {string} apiKey
   */
  async run(address, apiKey) {
    if (this.busy) throw new Error(`Worker ${this.id} busy`);
    this.busy = true;
    this.lastError = null;
    this.lastAddress = address;
    this.runId += 1;
    const myRun = this.runId;
    this.logs = [];

    try {
      if (!apiKey) throw new Error("No CapSolver key");

      let attempt = 0;
      while (true) {
        attempt += 1;
        this.setStatus(
          "running",
          attempt === 1
            ? `Claim run #${myRun}`
            : `Retry #${attempt} (refresh browser)…`,
        );

        try {
          // Always fresh page load on each attempt
          await this.openFaucet();

          const networkKeys = [];
          const apiHits = [];

          this.detachPageListeners();
          this._onReq = (req) => {
            const u = req.url();
            if (/recaptcha/i.test(u)) {
              try {
                const k = new URL(u).searchParams.get("k");
                if (k?.startsWith("6L") && !networkKeys.includes(k)) {
                  networkKeys.push(k);
                }
              } catch {
                /* ignore */
              }
            }
          };
          this._onRes = async (res) => {
            try {
              const url = res.url();
              const kind = res.request().resourceType();
              if (
                (kind === "xhr" || kind === "fetch") &&
                /faucet\.circle\.com\/api|graphql/i.test(url)
              ) {
                let body = "";
                try {
                  body = await res.text();
                } catch {
                  body = "";
                }
                if (body.length < 80000) {
                  apiHits.push({ status: res.status(), body });
                  this.log(`API ${res.status()}`);
                }
              }
            } catch {
              /* ignore */
            }
          };
          this.page.on("request", this._onReq);
          this.page.on("response", this._onRes);

          // Form is already visible → work immediately, no extra wait
          this.setStatus("running", "Filling form…");
          await this.fillForm(address);

          this.setStatus("running", "Send #1…");
          let btn = this.sendBtn();
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn
            .click({ timeout: 8000 })
            .catch(() => btn.click({ force: true }));

          // Short captcha UI poll (don't stall)
          for (let i = 0; i < 12; i++) {
            const cfMid = await this.detectCloudflareBlock();
            if (cfMid.blocked) break;
            const ok = await this.page.evaluate(() => {
              const t = (document.body?.innerText || "").toLowerCase();
              return (
                t.includes("i'm not a robot") ||
                t.includes("unusual traffic") ||
                Boolean(document.querySelector("iframe[src*='recaptcha']"))
              );
            });
            if (ok) break;
            await sleep(150);
          }

          {
            const cf = await this.detectCloudflareBlock();
            if (cf.blocked) {
              this.log("CF after Send#1 — refresh now");
              await sleep(400);
              continue;
            }
          }

          const siteKeys = await this.extractSiteKeys(networkKeys);
          this.log(`keys: ${siteKeys.map((k) => k.slice(0, 10)).join(",")}`);

          let token = null;
          let lastErr = null;
          for (const websiteKey of siteKeys) {
            try {
              this.setStatus(
                "solving_captcha",
                `CapSolver ${websiteKey.slice(0, 12)}…`,
              );
              const result = await solveRecaptchaV2(
                apiKey,
                {
                  websiteURL: FAUCET_URL,
                  websiteKey,
                  isInvisible: websiteKey === INVIS_KEY,
                },
                (m) => this.setStatus("solving_captcha", m),
              );
              token = result.token;
              this.log(`SOLVED ${result.taskType}`);
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e.message : String(e);
              this.log(`solve fail: ${lastErr}`);
            }
          }
          if (!token) {
            this.log(`CapSolver failed — refresh & retry: ${lastErr}`);
            await sleep(1000);
            continue;
          }
          if (this.page.isClosed()) {
            this.log("tab closed — reopen browser");
            await this.resetBrowser().catch(() => {});
            continue;
          }

          this.setStatus("submitting", "Inject token…");
          await injectRecaptchaToken(this.page, token);
          await sleep(120);
          await injectRecaptchaToken(this.page, token);

          this.setStatus("submitting", "Send #2…");
          btn = this.sendBtn();
          const before = apiHits.length;
          await btn
            .click({ timeout: 8000 })
            .catch(() => btn.click({ force: true }));

          this.setStatus("submitting", "Waiting API…");
          let outcome = "unknown";
          const deadline = Date.now() + 25000;
          while (Date.now() < deadline) {
            for (const hit of apiHits.slice(before)) {
              const b = (hit.body || "").toLowerCase();
              if (hit.status >= 200 && hit.status < 300) {
                if (/limit|exceed|too many|rate/i.test(b)) outcome = "limit";
                else if (/captcha|recaptcha|robot|invalid token/i.test(b))
                  outcome = "captcha_fail";
                else if (/"data"|success|txid|request/i.test(b))
                  outcome = "success";
              } else if (hit.status === 429) outcome = "limit";
              else if (hit.status >= 400) {
                if (/limit|exceed/i.test(b)) outcome = "limit";
                if (/captcha|robot|token/i.test(b)) outcome = "captcha_fail";
              }
            }
            if (outcome !== "unknown") break;

            const live = await this.page.evaluate(() => {
              const t = (document.body?.innerText || "").toLowerCase();
              const faq = t.indexOf("frequently asked");
              return faq > 0 ? t.slice(0, faq) : t;
            });
            if (
              /successfully|tokens sent|usdc sent|request submitted/i.test(live)
            ) {
              outcome = "success";
              break;
            }
            if (
              (/limit exceeded|you have exceeded|rate limit/i.test(live) ||
                /try again later/i.test(live)) &&
              !/why am i seeing/i.test(live)
            ) {
              outcome = "limit";
              break;
            }
            // CF mid-wait
            if (
              /error 1015|you are being rate limited|access denied/i.test(live)
            ) {
              outcome = "cf";
              break;
            }
            await sleep(250);
          }

          if (outcome === "unknown") {
            const still = await this.page.evaluate(() =>
              (document.body?.innerText || "")
                .toLowerCase()
                .includes("unusual traffic"),
            );
            outcome = still ? "captcha_fail" : "soft_success";
          }

          this.log(`outcome=${outcome} attempt=${attempt}`);

          // Permanent only: real per-wallet 2h faucet limit
          if (outcome === "limit") {
            throw new Error(
              "Faucet limit exceeded (20 USDC / address / 2h). Use new wallet.",
            );
          }

          // Everything else: refresh and try again
          if (
            outcome === "captcha_fail" ||
            outcome === "cf" ||
            outcome === "unknown"
          ) {
            this.log(`${outcome} — refresh & retry now`);
            await sleep(300);
            continue;
          }

          // success / soft_success
          this.setStatus("done", `OK run #${myRun}`);
          await this.page
            .goto(FAUCET_URL, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            })
            .catch(() => {});
          this.setStatus("idle", `Ready (last #${myRun} OK)`);
          return { ok: true, runId: myRun, outcome };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Permanent wallet limit bubbles out
          if (
            /20 usdc \/ address|faucet limit exceeded|every 2h|last 2h/i.test(
              msg,
            )
          ) {
            throw e;
          }
          // Any other error: refresh immediately and retry
          this.lastError = msg;
          this.log(`fail: ${msg.slice(0, 120)} — refresh now`);
          if (/closed|target page|context|browser has been closed/i.test(msg)) {
            await this.resetBrowser().catch(() => {});
          } else {
            try {
              await this.page?.goto(FAUCET_URL, {
                waitUntil: "commit",
                timeout: 20000,
              });
            } catch {
              /* openFaucet next loop */
            }
          }
          await sleep(300);
        }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.setStatus("error", this.lastError);
      this.status = "idle";
      throw e;
    } finally {
      this.detachPageListeners();
      this.busy = false;
    }
  }

  async cancel() {
    this.busy = false;
    this.detachPageListeners();
    this.setStatus("idle", "Cancelled");
  }

  async shutdown() {
    this.busy = false;
    this.detachPageListeners();
    await this.resetBrowser();
    this.setStatus("idle", "Shutdown");
  }
}
