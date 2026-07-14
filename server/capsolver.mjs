/**
 * CapSolver — Circle faucet uses reCAPTCHA Enterprise.
 * Visible checkbox: 6LcCqC8s…  |  Invisible: 6LcNs_0p…
 * Docs: https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/
 */

const API = "https://api.capsolver.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} clientKey
 * @param {{ websiteURL: string, websiteKey: string, isInvisible?: boolean }} opts
 * @param {(msg: string) => void} [onProgress]
 */
export async function solveRecaptchaV2(clientKey, opts, onProgress = () => {}) {
  if (!clientKey || clientKey.length < 8) {
    throw new Error("CapSolver API key missing");
  }
  if (!opts.websiteKey || !/^6L[A-Za-z0-9_-]{30,}$/.test(opts.websiteKey)) {
    throw new Error(`Invalid websiteKey: ${opts.websiteKey}`);
  }

  const websiteURL = opts.websiteURL.startsWith("http")
    ? opts.websiteURL
    : `https://${opts.websiteURL}`;

  const isInvisible = Boolean(opts.isInvisible);

  // Enterprise FIRST — Circle uses enterprise endpoints
  /** @type {Record<string, unknown>[]} */
  const variants = [
    {
      type: "ReCaptchaV2EnterpriseTaskProxyLess",
      websiteURL,
      websiteKey: opts.websiteKey,
      isInvisible,
    },
    {
      type: "ReCaptchaV2EnterpriseTaskProxyLess",
      websiteURL,
      websiteKey: opts.websiteKey,
      isInvisible: !isInvisible,
    },
    {
      type: "ReCaptchaV2TaskProxyLess",
      websiteURL,
      websiteKey: opts.websiteKey,
      isInvisible,
    },
    {
      type: "ReCaptchaV2TaskProxyLess",
      websiteURL,
      websiteKey: opts.websiteKey,
      isInvisible: !isInvisible,
    },
  ];

  let lastErr = "";
  for (const task of variants) {
    try {
      onProgress(
        `CapSolver ${task.type} invisible=${Boolean(task.isInvisible)} key=${String(opts.websiteKey).slice(0, 12)}…`,
      );
      const token = await createAndPoll(clientKey, task, onProgress);
      return {
        token,
        taskType: String(task.type),
        isInvisible: Boolean(task.isInvisible),
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      onProgress(`fail: ${lastErr}`);
      if (/insufficient|balance|invalid key|ERROR_KEY|ERROR_ZERO_BALANCE/i.test(lastErr)) {
        throw new Error(lastErr);
      }
    }
  }
  throw new Error(lastErr || "All CapSolver variants failed");
}

async function createAndPoll(clientKey, task, onProgress) {
  const createRes = await fetch(`${API}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, task }),
  });
  const create = await createRes.json();
  if (create.errorId) {
    throw new Error(
      create.errorDescription || create.errorCode || JSON.stringify(create),
    );
  }
  if (create.status === "ready" && create.solution?.gRecaptchaResponse) {
    return create.solution.gRecaptchaResponse;
  }
  const taskId = create.taskId;
  if (!taskId) throw new Error(`No taskId: ${JSON.stringify(create)}`);

  onProgress(`poll ${taskId}…`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await fetch(`${API}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, taskId }),
    });
    const data = await r.json();
    if (data.errorId && data.status !== "processing") {
      throw new Error(
        data.errorDescription || data.errorCode || JSON.stringify(data),
      );
    }
    if (data.status === "ready") {
      const tok = data.solution?.gRecaptchaResponse;
      if (!tok) throw new Error("ready without token");
      onProgress(`token ok (${tok.length} chars)`);
      return tok;
    }
    if (data.status === "failed") {
      throw new Error(`failed: ${JSON.stringify(data)}`);
    }
  }
  throw new Error("CapSolver timeout 180s");
}

export async function getCapsolverBalance(clientKey) {
  const r = await fetch(`${API}/getBalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  return r.json();
}

/** Prefer visible checkbox key, then invisible. Drop junk base64 co= values. */
export function orderSiteKeys(keys) {
  const VISIBLE = "6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve";
  const INVIS = "6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2";
  const clean = [...new Set(keys)].filter(
    (k) => typeof k === "string" && /^6L[A-Za-z0-9_-]{35,}$/.test(k),
  );
  const ordered = [];
  if (clean.includes(VISIBLE)) ordered.push(VISIBLE);
  if (clean.includes(INVIS)) ordered.push(INVIS);
  for (const k of clean) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  // always end with known fallbacks
  for (const k of [VISIBLE, INVIS]) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered;
}
