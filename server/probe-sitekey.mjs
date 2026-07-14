import { chromium } from "playwright";

const address = process.argv[2] || "0x0C5E9C66886Df351d92926c818fAF0A89af66FEb";
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage();
const networkKeys = new Set();
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("recaptcha")) {
    try {
      const k = new URL(u).searchParams.get("k");
      if (k) networkKeys.add(k);
    } catch {
      /* ignore */
    }
  }
});

await page.goto("https://faucet.circle.com/", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(2000);
try {
  await page.getByRole("button", { name: /^USDC$/i }).first().click({ timeout: 5000 });
} catch {
  /* ignore */
}
const input = page.getByPlaceholder(/wallet address/i).first();
await input.fill(address);
await page.waitForTimeout(400);
const send = page.locator("button").filter({ hasText: /Send\s+\d+\s*USDC/i }).first();
await send.scrollIntoViewIfNeeded();
await send.click({ timeout: 10000 }).catch(() => send.click({ force: true }));
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const keys = [];
  document.querySelectorAll("[data-sitekey]").forEach((el) => {
    keys.push(el.getAttribute("data-sitekey"));
  });
  document.querySelectorAll("iframe[src*='recaptcha']").forEach((el) => {
    try {
      const k = new URL(el.src).searchParams.get("k");
      if (k) keys.push(k);
    } catch {
      /* ignore */
    }
  });
  const htmlKeys = document.documentElement.innerHTML.match(/6L[A-Za-z0-9_-]{30,}/g) || [];
  const clients =
    typeof window.___grecaptcha_cfg !== "undefined"
      ? Object.keys(window.___grecaptcha_cfg.clients || {})
      : [];
  return {
    keys: [...new Set([...keys, ...htmlKeys])],
    clients,
    hasRobot: (document.body.innerText || "").includes("I'm not a robot"),
    unusual: (document.body.innerText || "").includes("unusual traffic"),
    iframes: [...document.querySelectorAll("iframe")].map((f) => f.src).slice(0, 8),
  };
});

console.log(
  JSON.stringify(
    {
      networkKeys: [...networkKeys],
      ...info,
    },
    null,
    2,
  ),
);
await browser.close();
