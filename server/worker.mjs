/**
 * One browser worker — independent Chrome context for parallel faucet claims.
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
const VISIBLE_KEY = FALLBACK_SITEKEYS[0];
const INVIS_KEY = FALLBACK_SITEKEYS[1];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  async ensureBrowser() {
    if (this.context) {
      try {
        this.context.pages();
        return;
      } catch {
        this.context = null;
        this.page = null;
      }
    }

    const profile = join(ROOT, `.browser-profile-w${this.id}`);
    const common = {
      headless: false,
      viewport: null,
      locale: "en-US",
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-position=${40 + this.id * 40},${40 + this.id * 30}`,
        "--window-size=1280,900",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };

    try {
      this.context = await chromium.launchPersistentContext(profile, {
        ...common,
        channel: "chrome",
      });
    } catch {
      this.context = await chromium.launchPersistentContext(profile, common);
    }

    this.context.on("close", () => {
      this.context = null;
      this.page = null;
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    // close junk tabs
    for (const p of this.context.pages().slice(1)) {
      await p.close().catch(() => {});
    }
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.log("browser ready");
  }

  async openFaucet() {
    await this.ensureBrowser();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    this.page.setDefaultTimeout(12000);
    this.setStatus("running", "Opening faucet…");
    // commit is faster than full domcontentloaded wait when page is cached
    await this.page.goto(FAUCET_URL, {
      waitUntil: "commit",
      timeout: 45000,
    });
    try {
      await this.page.bringToFront();
    } catch {
      /* ignore */
    }

    const addressInput = this.page
      .getByPlaceholder(/wallet address/i)
      .or(this.page.locator('input[placeholder*="address" i]'))
      .first();
    await addressInput.waitFor({ state: "visible", timeout: 20000 });
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
    // USDC + Arc often already default — only click if needed (fast path)
    try {
      const usdc = p
        .getByRole("button", { name: /^USDC$/i })
        .or(p.locator("button").filter({ hasText: /^USDC$/ }))
        .first();
      await usdc.click({ timeout: 1500 });
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

      const onReq = (req) => {
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
      const onRes = async (res) => {
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
      this.page.on("request", onReq);
      this.page.on("response", onRes);

      this.setStatus("running", "Filling form…");
      await this.fillForm(address);

      if (!this.page.url().includes("faucet.circle.com")) {
        throw new Error("Lost faucet page");
      }

      this.setStatus("running", "Send #1…");
      let btn = this.sendBtn();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 10000 }).catch(() => btn.click({ force: true }));

      // wait captcha ui briefly
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
      // quick reload for next job (commit = faster)
      await this.page
        .goto(FAUCET_URL, { waitUntil: "commit", timeout: 15000 })
        .catch(() => {});
      this.setStatus("idle", `Ready (last #${myRun} OK)`);
      return { ok: true, runId: myRun, outcome };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.setStatus("error", this.lastError);
      try {
        if (this.page && !this.page.isClosed()) {
          await this.page
            .goto(FAUCET_URL, { waitUntil: "domcontentloaded", timeout: 15000 })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      // flip idle so next job can use worker
      this.status = "idle";
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async cancel() {
    this.busy = false;
    this.setStatus("idle", "Cancelled");
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.goto(FAUCET_URL, { timeout: 10000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  async shutdown() {
    this.busy = false;
    try {
      await this.page?.close().catch(() => {});
      await this.context?.close().catch(() => {});
    } finally {
      this.page = null;
      this.context = null;
      this.setStatus("idle", "Shutdown");
    }
  }
}
