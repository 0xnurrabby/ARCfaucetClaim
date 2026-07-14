/**
 * Check if a wallet already received faucet USDC in the last 2 hours on Arc Testnet.
 * Uses Alchemy RPC getLogs for ERC-20 Transfer + native balance movement heuristics.
 */

const USDC = "0x3600000000000000000000000000000000000000";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
/** Arc ~0.5s blocks → ~7200 blocks/hour → ~15000 for 2h with buffer */
const BLOCKS_2H = 16_000n;
/** Faucet amount is 20 USDC (6 decimals) */
const FAUCET_RAW_MIN = 19n * 10n ** 6n;
const FAUCET_RAW_MAX = 21n * 10n ** 6n;

function padAddress(addr) {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function rpc(rpcUrl, method, params = []) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

/**
 * @param {string} rpcUrl
 * @param {string} address
 * @returns {Promise<{ limited: boolean, reason?: string, lastClaimAt?: number, amount?: string }>}
 */
export async function checkRecentFaucetClaim(rpcUrl, address) {
  if (!rpcUrl) {
    return { limited: false, reason: "no_rpc" };
  }
  const addr = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    throw new Error("Invalid address for claim check");
  }

  try {
    const latestHex = await rpc(rpcUrl, "eth_blockNumber");
    const latest = BigInt(latestHex);
    const fromBlock = latest > BLOCKS_2H ? latest - BLOCKS_2H : 0n;

    // ERC-20 Transfer(from, to=addr, value) on USDC contract
    const logs = await rpc(rpcUrl, "eth_getLogs", [
      {
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "latest",
        address: USDC,
        topics: [TRANSFER_TOPIC, null, padAddress(addr)],
      },
    ]);

    if (!Array.isArray(logs) || logs.length === 0) {
      // Also try Alchemy asset transfers if available
      try {
        const alt = await checkAlchemyTransfers(rpcUrl, addr);
        if (alt) return alt;
      } catch {
        /* ignore */
      }
      return { limited: false, reason: "no_inbound_usdc_2h" };
    }

    // Newest first
    const sorted = [...logs].sort(
      (a, b) => Number(BigInt(b.blockNumber)) - Number(BigInt(a.blockNumber)),
    );

    for (const log of sorted) {
      const value = BigInt(log.data || "0x0");
      // faucet-like amount OR any large inbound (>= 10 USDC)
      const isFaucetLike =
        (value >= FAUCET_RAW_MIN && value <= FAUCET_RAW_MAX) ||
        value >= 10n * 10n ** 6n;

      if (!isFaucetLike) continue;

      let ts = Date.now();
      try {
        const block = await rpc(rpcUrl, "eth_getBlockByNumber", [
          log.blockNumber,
          false,
        ]);
        if (block?.timestamp) {
          ts = Number(BigInt(block.timestamp)) * 1000;
        }
      } catch {
        /* use now */
      }

      if (Date.now() - ts <= TWO_HOURS_MS) {
        const amount = (Number(value) / 1e6).toFixed(2);
        return {
          limited: true,
          reason: "recent_inbound_usdc",
          lastClaimAt: ts,
          amount,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        };
      }
    }

    return { limited: false, reason: "inbound_older_than_2h" };
  } catch (e) {
    // Don't block queue on RPC failure — report and allow attempt
    return {
      limited: false,
      reason: "check_failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkAlchemyTransfers(rpcUrl, addr) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [
        {
          fromBlock: "0x0",
          toBlock: "latest",
          toAddress: addr,
          category: ["erc20", "external"],
          withMetadata: true,
          maxCount: "0x20",
          order: "desc",
        },
      ],
    }),
  });
  const j = await r.json();
  if (j.error || !j.result?.transfers) return null;

  const cutoff = Date.now() - TWO_HOURS_MS;
  for (const t of j.result.transfers) {
    const val = Number(t.value || 0);
    if (val < 10) continue;
    const ts = t.metadata?.blockTimestamp
      ? Date.parse(t.metadata.blockTimestamp)
      : 0;
    if (ts && ts >= cutoff) {
      return {
        limited: true,
        reason: "alchemy_transfer",
        lastClaimAt: ts,
        amount: String(val),
        txHash: t.hash,
      };
    }
  }
  return { limited: false, reason: "alchemy_no_recent" };
}
