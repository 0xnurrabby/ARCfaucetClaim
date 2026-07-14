import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  isHex,
  parseGwei,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

export const DESTINATION = "0xFED4Fe804d6F44AC6C176a4FFB131Ea91e6ab529" as const;
export const USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;
export const USDC_DECIMALS = 6;
export const FAUCET_URL = "https://faucet.circle.com/";
export const EXPLORER_TX = "https://testnet.arcscan.app/tx/";
/** Override via window.__ARC_RPC_URL or default public Arc RPC */
export const RPC_URL =
  (typeof window !== "undefined" &&
    (window as unknown as { __ARC_RPC_URL?: string }).__ARC_RPC_URL) ||
  "https://rpc.testnet.arc.network";
export const FAUCET_AMOUNT = "20";
export const API_BASE = "http://127.0.0.1:8787";

/** Arc min base fee floor is 20 gwei; tip helps inclusion. */
const MAX_FEE_PER_GAS = parseGwei("30");
const MAX_PRIORITY_FEE_PER_GAS = parseGwei("1");
const SIMPLE_TRANSFER_GAS = 21_000n;
/** Extra safety buffer in native wei (18 decimals) so fee never eats the send. */
const GAS_SAFETY_WEI = parseUnits("0.05", 18);

export const usdcAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

export function normalizePrivateKey(input: string): Hex {
  const raw = input.trim();
  const with0x = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHex(with0x) || with0x.length !== 66) {
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string");
  }
  return with0x;
}

export function accountFromPrivateKey(privateKey: string) {
  return privateKeyToAccount(normalizePrivateKey(privateKey));
}

export function walletClientFromPrivateKey(privateKey: string): WalletClient {
  const account = accountFromPrivateKey(privateKey);
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(RPC_URL),
  });
}

export function isValidAddress(value: string): value is Address {
  return isAddress(value);
}

/** ERC-20 view (6 decimals) — display only. Same pool as native. */
export async function getUsdcBalance(address: Address): Promise<{
  raw: bigint;
  formatted: string;
}> {
  const raw = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [address],
  });
  return {
    raw,
    formatted: formatUnits(raw, USDC_DECIMALS),
  };
}

/** Native balance (18 decimals) — used for gas + value sends on Arc. */
export async function getNativeBalance(address: Address): Promise<{
  raw: bigint;
  formatted6: string;
}> {
  const raw = await publicClient.getBalance({ address });
  // Show as 6-decimal USDC for humans (truncate native → 6dp)
  return {
    raw,
    formatted6: formatUnits(raw / 10n ** 12n, USDC_DECIMALS),
  };
}

function gasReserveWei(): bigint {
  return SIMPLE_TRANSFER_GAS * MAX_FEE_PER_GAS + GAS_SAFETY_WEI;
}

/**
 * On Arc, USDC native + ERC-20 are ONE balance.
 * Sending full ERC-20 amount leaves nothing for gas → tx reverts.
 * Prefer native `sendTransaction` and always keep a gas reserve.
 */
export async function transferUsdc(params: {
  privateKey: string;
  to: Address;
  amountFormatted?: string;
  sendAll?: boolean;
}): Promise<{ hash: Hex; sentFormatted: string }> {
  const wallet = walletClientFromPrivateKey(params.privateKey);
  const account = wallet.account;
  if (!account) throw new Error("Wallet account missing");

  const native = await publicClient.getBalance({ address: account.address });
  const reserve = gasReserveWei();

  if (native <= reserve) {
    throw new Error(
      `Not enough USDC for gas. Native: ${formatUnits(native / 10n ** 12n, 6)} USDC, need ~${formatUnits(reserve / 10n ** 12n, 6)} for fees`,
    );
  }

  let valueWei: bigint;

  if (params.sendAll) {
    valueWei = native - reserve;
  } else {
    const amount6 = parseUnits(params.amountFormatted ?? "0", USDC_DECIMALS);
    if (amount6 <= 0n) throw new Error("Transfer amount must be greater than 0");
    // Convert 6-decimal USDC amount → 18-decimal native wei
    valueWei = amount6 * 10n ** 12n;
    if (valueWei + reserve > native) {
      // Auto-clamp so user can still send "20" after faucet with gas left
      valueWei = native - reserve;
    }
  }

  if (valueWei <= 0n) {
    throw new Error("Nothing left to send after reserving gas");
  }

  const sentFormatted = formatUnits(valueWei / 10n ** 12n, USDC_DECIMALS);

  const hash = await wallet.sendTransaction({
    account,
    chain: arcTestnet,
    to: params.to,
    value: valueWei,
    gas: SIMPLE_TRANSFER_GAS,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  });

  // Arc finality is sub-second — short poll, don't hang UI
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 20_000,
    pollingInterval: 250,
  });
  if (receipt.status !== "success") {
    throw new Error(
      "Transfer reverted. On Arc, USDC pays gas — keep a tiny reserve or use Send all.",
    );
  }

  return { hash, sentFormatted };
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
