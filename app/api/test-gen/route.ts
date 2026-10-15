import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, isAddress, parseEther, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// TrustGate V1.3 test-GEN faucet (Studio Next, chain 61997). Separate from the V1 faucet.
// Key: V13_FAUCET_PRIVATE_KEY (Cloudflare secret / .env.local), never sent to the browser.
// Limits (24 h windows, kept in the TG_LIMITS KV namespace; in-memory fallback for local dev):
//   - one claim per wallet address,
//   - PER_IP claims per network (several judges can share one office or event Wi-Fi),
//   - GLOBAL_PER_DAY claims in total, a safety budget so the faucet cannot be drained.
// AMOUNT covers Try it (which needs no GEN) plus one full negotiation: create a vault, fund the browser
// agent key, request, and the fees.

export const dynamic = "force-dynamic";

const RPC_URL = "https://studio-dev.genlayer.com/api";
const AMOUNT = parseEther("2");
const WINDOW_SECONDS = 24 * 60 * 60;
const PER_IP = 6;
const GLOBAL_PER_DAY = 40;
const chain = defineChain({ id: 61997, name: "GenLayer Studio Next", nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

type Limits = { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
const memory = new Map<string, { value: string; until: number }>();
const memoryLimits: Limits = {
  async get(key) {
    const hit = memory.get(key);
    return hit && hit.until > Date.now() ? hit.value : null;
  },
  async put(key, value, opts) {
    memory.set(key, { value, until: Date.now() + (opts?.expirationTtl ?? WINDOW_SECONDS) * 1000 });
  },
  async delete(key) {
    memory.delete(key);
  },
};

function bindings(): { limits: Limits; key?: string } {
  try {
    const env = getCloudflareContext().env as unknown as { TG_LIMITS?: Limits; V13_FAUCET_PRIVATE_KEY?: string };
    return { limits: env.TG_LIMITS ?? memoryLimits, key: env.V13_FAUCET_PRIVATE_KEY ?? process.env.V13_FAUCET_PRIVATE_KEY };
  } catch {
    return { limits: memoryLimits, key: process.env.V13_FAUCET_PRIVATE_KEY };
  }
}

const fail = (error: string, status: number, retryAfter?: number) =>
  Response.json({ ok: false, error, retryAfter: retryAfter ?? null }, { status, headers: { "cache-control": "no-store" } });

function faucetAccount(key?: string) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

export async function GET() {
  const account = faucetAccount(bindings().key);
  if (!account) return Response.json({ ok: false, configured: false, amount: formatEther(AMOUNT) });
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const balance = await pub.getBalance({ address: account.address }).catch(() => null);
  return Response.json({ ok: true, configured: true, amount: formatEther(AMOUNT), address: account.address, empty: balance !== null && balance < AMOUNT, balance: balance === null ? null : formatEther(balance) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const { limits, key } = bindings();
  const account = faucetAccount(key);
  if (!account) return fail("The test GEN faucet is not configured on this deployment.", 503);

  let address: string;
  try {
    address = String(((await request.json()) as { address?: unknown }).address ?? "").trim();
  } catch {
    return fail("Send JSON: {\"address\": \"0x…\"}.", 400);
  }
  if (!isAddress(address) || getAddress(address) === zeroAddress) return fail("Enter a valid wallet address.", 400);
  const recipient = getAddress(address);
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const addrKey = `faucet:addr:${recipient.toLowerCase()}`;
  const ipKey = `faucet:ip:${ip}`;
  const globalKey = `faucet:global:${new Date().toISOString().slice(0, 10)}`;
  const lastClaim = await limits.get(addrKey);
  if (lastClaim) {
    const retryAfter = Math.max(0, Number(lastClaim) + WINDOW_SECONDS - Math.floor(Date.now() / 1000));
    return fail(`This wallet already received test GEN today (again in ${Math.ceil(retryAfter / 3600)} h). For the seller side, use a second wallet account; Try it needs no wallet at all.`, 429, retryAfter);
  }
  const ipCount = Number((await limits.get(ipKey)) ?? "0");
  if (ipCount >= PER_IP) return fail(`This network already made ${PER_IP} claims today. Try from another network, or use Try it (no wallet needed).`, 429, WINDOW_SECONDS);
  const globalCount = Number((await limits.get(globalKey)) ?? "0");
  if (globalCount >= GLOBAL_PER_DAY) return fail("Today's faucet budget is used up. Try it still works without a wallet; the faucet resets at 00:00 UTC.", 429, WINDOW_SECONDS);

  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  let reserved = false;
  try {
    const balance = await pub.getBalance({ address: account.address });
    if (balance < AMOUNT * BigInt(2)) return fail("The faucet is empty right now. Try it still works without a wallet.", 503);
    // Reserve the limits before sending so parallel requests cannot double-claim.
    const now = String(Math.floor(Date.now() / 1000));
    await limits.put(addrKey, now, { expirationTtl: WINDOW_SECONDS });
    await limits.put(ipKey, String(ipCount + 1), { expirationTtl: WINDOW_SECONDS });
    await limits.put(globalKey, String(globalCount + 1), { expirationTtl: WINDOW_SECONDS + 3600 });
    reserved = true;
    const hash = await wallet.sendTransaction({ to: recipient, value: AMOUNT });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 2000 }).catch(() => null);
    return Response.json(
      { ok: true, hash, amount: formatEther(AMOUNT), confirmed: receipt?.status === "success", to: recipient },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (reserved) {
      // Nothing was sent: give the claim back.
      await limits.delete(addrKey).catch(() => undefined);
      await limits.put(ipKey, String(ipCount), { expirationTtl: WINDOW_SECONDS }).catch(() => undefined);
      await limits.put(globalKey, String(globalCount), { expirationTtl: WINDOW_SECONDS + 3600 }).catch(() => undefined);
    }
    const message = error instanceof Error ? (error as Error & { shortMessage?: string }).shortMessage ?? error.message.split("\n")[0] : "unknown error";
    return fail(`The faucet transfer failed: ${message}. Try again in a minute.`, 502);
  }
}
