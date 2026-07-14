/**
 * One faucet worker = one browser context (tab group).
 * All workers share a single Chromium/Chrome process for stability at high parallel counts.
 */
import { chromium } from "playwright";
import { solveRecaptchaV2, orderSiteKeys } from "./capsolver.mjs";
import { injectRecaptchaToken } from "./recaptcha-inject.mjs";

const FAUCET_URL = "https://faucet.circle.com/";
const FALLBACK_SITEKEYS = [
  "6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve",
  "6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2",
];
const INVIS_KEY = FALLBACK_SITEKEYS[1];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @type {import('playwright').Browser | null} */
let sharedBrowser = null;
let browserLaunchPromise = null;

async function getSharedBrowser(onLog = () => {}) {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    onLog("[browser] launching shared Chrome process…");
    const args = [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ];
    try {
      sharedBrowser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args,
        ignoreDefaultArgs: ["--enable-automation"],
      });
    } catch {
      sharedBrowser = await chromium.launch({
        headless: false,
        args,
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
    sharedBrowser.on("disconnected", () => {
      sharedBrowser = null;
      browserLaunchPromise = null;
    });
    onLog("[browser] shared process ready");
    return sharedBrowser;
  })();

  try {
    return await browserLaunchPromise;
  } finally {
    browserLaunchPromise = null;
  }
}

export async function shutdownSharedBrowser() {
  try {
    if (sharedBrowser) await sharedBrowser.close();
  } catch {
    /* ignore */
  }
  sharedBrowser = null;
  browserLaunchPromise = null;
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
    /** @type {((...args: any[]) => void) | null} */
    this._onReq = null;
    /** @type {((...args: any[]) => void) | null} */
    this._onRes = null;
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

  async ensureContext() {
    // Reuse healthy context
    if (this.context) {
      try {
        const pages = this.context.pages();
        if (pages) {
          this.page =
            pages.find((p) => !p.isClosed()) || (await this.context.newPage());
          return;
        }
      } catch {
        this.context = null;
        this.page = null;
      }
    }

    const browser = await getSharedBrowser((m) => this.onLog(m));
    const col = (this.id * 37) % 800;
    const row = (this.id * 29) % 400;

    this.context = await browser.newContext({
      viewport: { width: 1100, height: 800 },
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);

    // Best-effort window placement (may no-op)
    try {
      await this.page.evaluate(
        ({ x, y }) => {
          try {
            window.moveTo(x, y);
          } catch {
            /* ignore */
          }
        },
        { x: 20 + col, y: 20 + row },
      );
    } catch {
      /* ignore */
    }

    this.log("context ready");
  }

  async resetContext() {
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
            "Cloudflare Error 1015: IP rate limited. Lower parallel browsers and wait.",
        };
      }
      return { blocked: false };
    } catch {
      return { blocked: false };
    }
  }

  async openFaucet() {
    await this.ensureContext();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    this.page.setDefaultTimeout(15000);
    this.setStatus("running", "Opening faucet…");

    await this.page.goto(FAUCET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    const cf = await this.detectCloudflareBlock();
    if (cf.blocked) {
      const err = new Error(cf.message);
      // @ts-ignore
      err.code = "CF_1015";
      throw err;
    }

    const addressInput = this.page
      .getByPlaceholder(/wallet address/i)
      .or(this.page.locator('input[placeholder*="address" i]'))
      .first();
    try {
      await addressInput.waitFor({ state: "visible", timeout: 20000 });
    } catch {
      const cf2 = await this.detectCloudflareBlock();
      if (cf2.blocked) {
        const err = new Error(cf2.message);
        // @ts-ignore
        err.code = "CF_1015";
        throw err;
      }
      // recreate context once and retry
      this.log("form missing — resetting context and retrying once");
      await this.resetContext();
      await this.ensureContext();
      await this.page.goto(FAUCET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      const cf3 = await this.detectCloudflareBlock();
      if (cf3.blocked) {
        const err = new Error(cf3.message);
        // @ts-ignore
        err.code = "CF_1015";
        throw err;
      }
      await this.page
        .getByPlaceholder(/wallet address/i)
        .or(this.page.locator('input[placeholder*="address" i]'))
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
    }

    await this.sendBtn()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});

    if (!this.page.url().includes("faucet.circle.com")) {
      throw new Error(`Wrong URL: ${this.page.url()}`);
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

      await this.openFaucet();
      const networkKeys = [];
      const apiHits = [];

      this.detachPageListeners();
      this._onReq = (req) => {
        const u = req.url();
        if (/recaptcha/i.test(u)) {
          try {
            const k = new URL(u).searchParams.get("k");
            if (k?.startsWith("6L") && !networkKeys.includes(k)) networkKeys.push(k);
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

      this.setStatus("running", "Filling form…");
      await this.fillForm(address);

      if (!this.page.url().includes("faucet.circle.com")) {
        throw new Error("Lost faucet page");
      }

      this.setStatus("running", "Send #1…");
      let btn = this.sendBtn();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 10000 }).catch(() => btn.click({ force: true }));

      for (let i = 0; i < 20; i++) {
        const ok = await this.page.evaluate(() => {
          const t = (document.body?.innerText || "").toLowerCase();
          return (
            t.includes("i'm not a robot") ||
            t.includes("unusual traffic") ||
            Boolean(document.querySelector("iframe[src*='recaptcha']"))
          );
        });
        if (ok) break;
        await sleep(250);
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
      if (!token) throw new Error(`CapSolver failed: ${lastErr}`);

      if (this.page.isClosed()) throw new Error("Tab closed during CapSolver");

      this.setStatus("submitting", "Inject token…");
      await injectRecaptchaToken(this.page, token);
      await sleep(120);
      await injectRecaptchaToken(this.page, token);

      this.setStatus("submitting", "Send #2…");
      btn = this.sendBtn();
      const before = apiHits.length;
      await btn.click({ timeout: 8000 }).catch(() => btn.click({ force: true }));

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
            else if (/"data"|success|txid|request/i.test(b)) outcome = "success";
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
        if (/successfully|tokens sent|usdc sent|request submitted/i.test(live)) {
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

      this.log(`outcome=${outcome} run=${myRun}`);

      if (outcome === "limit") {
        throw new Error(
          "Faucet limit exceeded (20 USDC / address / 2h). Use new wallet.",
        );
      }
      if (outcome === "captcha_fail") {
        throw new Error("Captcha rejected — retry");
      }

      this.setStatus("done", `OK run #${myRun}`);
      await this.page
        .goto(FAUCET_URL, { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {});
      this.setStatus("idle", `Ready (last #${myRun} OK)`);
      return { ok: true, runId: myRun, outcome };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.setStatus("error", this.lastError);
      // recreate context after hard failures so next job works
      if (
        /1015|cloudflare|timeout|closed|target page|context|browser/i.test(
          this.lastError,
        )
      ) {
        await this.resetContext().catch(() => {});
      } else {
        try {
          if (this.page && !this.page.isClosed()) {
            await this.page
              .goto(FAUCET_URL, {
                waitUntil: "domcontentloaded",
                timeout: 12000,
              })
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
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
    await this.resetContext();
    this.setStatus("idle", "Shutdown");
  }
}
