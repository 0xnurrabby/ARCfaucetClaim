/**
 * Inject token for reCAPTCHA Enterprise (Circle faucet).
 */

export async function injectRecaptchaToken(page, token) {
  return page.evaluate((tok) => {
    const report = {
      textareas: 0,
      callbacks: 0,
      enterprisePatched: false,
      standardPatched: false,
    };

    // Textareas
    const areas = document.querySelectorAll(
      'textarea[name="g-recaptcha-response"], textarea[id*="g-recaptcha-response"], #g-recaptcha-response',
    );
    if (areas.length === 0) {
      const el = document.createElement("textarea");
      el.id = "g-recaptcha-response";
      el.name = "g-recaptcha-response";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    document
      .querySelectorAll(
        'textarea[name="g-recaptcha-response"], textarea[id*="g-recaptcha-response"], #g-recaptcha-response',
      )
      .forEach((el) => {
        el.value = tok;
        el.innerHTML = tok;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        report.textareas += 1;
      });

    const patchGetResponse = (obj) => {
      if (!obj || typeof obj !== "object") return false;
      try {
        obj.getResponse = function () {
          return tok;
        };
        // enterprise sometimes uses execute promise path
        if (typeof obj.execute === "function") {
          const orig = obj.execute.bind(obj);
          obj.execute = function (...args) {
            try {
              const p = orig(...args);
              if (p && typeof p.then === "function") {
                return Promise.resolve(tok);
              }
            } catch {
              /* fall through */
            }
            return Promise.resolve(tok);
          };
        }
        return true;
      } catch {
        return false;
      }
    };

    try {
      // @ts-ignore
      if (window.grecaptcha) {
        // @ts-ignore
        report.standardPatched = patchGetResponse(window.grecaptcha);
        // @ts-ignore
        if (window.grecaptcha.enterprise) {
          // @ts-ignore
          report.enterprisePatched = patchGetResponse(window.grecaptcha.enterprise);
        }
      }
    } catch {
      /* ignore */
    }

    // data-callback
    document.querySelectorAll("[data-callback]").forEach((el) => {
      const name = el.getAttribute("data-callback");
      // @ts-ignore
      if (name && typeof window[name] === "function") {
        try {
          // @ts-ignore
          window[name](tok);
          report.callbacks += 1;
        } catch {
          /* ignore */
        }
      }
    });

    // Deep walk clients — fire every function that looks like a callback
    try {
      // @ts-ignore
      const cfg = window.___grecaptcha_cfg;
      if (cfg?.clients) {
        const seen = new WeakSet();
        const walk = (node, depth) => {
          if (!node || depth > 12) return;
          if (typeof node === "function") {
            try {
              // call with token (most callbacks are (token) => void)
              if (node.length <= 2) {
                node(tok);
                report.callbacks += 1;
              }
            } catch {
              /* ignore */
            }
            return;
          }
          if (typeof node !== "object") return;
          try {
            if (seen.has(node)) return;
            seen.add(node);
          } catch {
            return;
          }
          for (const key of Object.keys(node)) {
            try {
              walk(node[key], depth + 1);
            } catch {
              /* ignore */
            }
          }
        };
        for (const id of Object.keys(cfg.clients)) {
          walk(cfg.clients[id], 0);
        }
      }
    } catch {
      /* ignore */
    }

    return report;
  }, token);
}

export async function tryClickRecaptchaCheckbox(page) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!/recaptcha\/enterprise\/anchor|recaptcha\/api2\/anchor|recaptcha.*anchor/i.test(url)) {
      continue;
    }
    // Prefer the non-invisible (size=normal) anchor — checkbox
    if (url.includes("size=invisible")) continue;
    try {
      const box = frame.locator(
        "#recaptcha-anchor, .recaptcha-checkbox-border, .recaptcha-checkbox",
      );
      if ((await box.count()) > 0) {
        await box.first().click({ timeout: 4000 });
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}
