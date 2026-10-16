import "server-only";

import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { getFeed } from "@/lib/feed-server";
import { buildNegotiations } from "@/lib/negotiation";
import { clientIp, limits, secret, ttl } from "@/lib/server-env";
import { buildLedger, formatGen, GEN, parseGen, termsHash, VAULT_CONTRACT } from "@/lib/vault";

// "Try it" without a wallet, both sides played by server-side demo wallets:
//   1. offer   - the demo SELLER (TRY_SELLER_PRIVATE_KEY) posts the visitor's text as a signed offer
//                to the demo vault (TRY_VAULT_ID on TRY_CONTRACT);
//   2. request - the demo AGENT (TRY_AGENT_PRIVATE_KEY) requests a commitment against that offer;
//                GenLayer validators judge it like any other request;
//   3. accept  - after RENEGOTIATE the visitor may click "seller accepts": the demo seller signs the
//                counterproposal word for word as a new version, then step 2 runs again.
// Both demo wallets are untrusted by design. Their keys are Cloudflare secrets and never reach the browser.

export const dynamic = "force-dynamic";

const tryContract = () => (secret("TRY_CONTRACT") ?? process.env.TRY_CONTRACT ?? VAULT_CONTRACT) as `0x${string}`;
// TRY_PER_IP_PER_HOUR overrides the per-IP limit (used by the local E2E test to check the limit cheaply).
const TRY_LIMITS = { minChars: 20, maxChars: 2000, perIpPerHour: Number(process.env.TRY_PER_IP_PER_HOUR ?? 4), defaultAmount: "0.5" };
const JUSTIFICATION = "Requested by the TrustGate demo agent for a website visitor's offer. The agent did not check it.";
const QUEUED = ["PENDING", "PROPOSING", "COMMITTING", "REVEALING", "ACTIVATED", "APPEAL_REVEALING", "APPEAL_COMMITTING", "LEADER_REVEALING"];

function config() {
  const agentKey = secret("TRY_AGENT_PRIVATE_KEY");
  const sellerKey = secret("TRY_SELLER_PRIVATE_KEY");
  const vaultId = secret("TRY_VAULT_ID") ?? process.env.NEXT_PUBLIC_TRY_VAULT_ID;
  const valid = (k?: string) => Boolean(k && /^0x[0-9a-fA-F]{64}$/.test(k));
  if (!valid(agentKey) || !valid(sellerKey) || !vaultId) return null;
  return {
    agentKey: agentKey as `0x${string}`, sellerKey: sellerKey as `0x${string}`, vaultId,
    agent: createAccount(agentKey as `0x${string}`).address.toLowerCase(), seller: createAccount(sellerKey as `0x${string}`).address.toLowerCase(),
  };
}
type Cfg = NonNullable<ReturnType<typeof config>>;

// POST handlers pass refresh = false: a feed refresh must not run in the same invocation as a demo-wallet write.
async function demoState(cfg: Cfg, refresh = true) {
  const { events } = await getFeed(tryContract(), { refresh });
  const vault = buildLedger(events).vaults.find((v) => v.vaultId === cfg.vaultId) ?? null;
  const queued = events.filter((e) => e.method === "request_commitment" && QUEUED.includes(e.status.toUpperCase())).length;
  return { vault, queued, events };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const errText = (e: unknown) => (e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message).split("\n")[0] : "unknown error");
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

async function write(key: `0x${string}`, method: string, args: unknown[]) {
  const client = createClient({ chain: studioDevnet, account: createAccount(key) });
  const e = await client.estimateTransactionFees();
  return client.writeContract({ address: tryContract(), functionName: method, args: args as never, fees: { distribution: e.distribution, messageAllocations: e.messageAllocations, feeValue: e.feeValue } });
}

async function waitDecided(key: `0x${string}`, hash: string) {
  const client = createClient({ chain: studioDevnet, account: createAccount(key) });
  for (let i = 0; i < 24; i++) {
    const tx = await client.getTransaction({ hash: hash as never }).catch(() => null);
    if (["ACCEPTED", "FINALIZED"].includes(String(tx?.statusName).toUpperCase())) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// One submission at a time per demo wallet (its nonce); other visitors retry a few seconds later.
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | Response> {
  const store = limits();
  if (await store.get(`try:lock:${name}`)) return json({ ok: false, busy: true, error: "Another visitor is submitting right now. Retrying…" }, 429);
  await store.put(`try:lock:${name}`, String(Date.now()), { expirationTtl: ttl(60) });
  try {
    return await fn();
  } finally {
    await store.delete(`try:lock:${name}`).catch(() => undefined);
  }
}

async function overLimit(request: Request, bucket: string, max: number) {
  const store = limits();
  const key = `try:${bucket}:${clientIp(request)}`;
  const used = Number((await store.get(key)) ?? "0");
  if (used >= max) return { blocked: true, bump: async () => undefined };
  return { blocked: false, bump: () => store.put(key, String(used + 1), { expirationTtl: ttl(3600) }) };
}

export async function GET() {
  const cfg = config();
  if (!cfg) return json({ ok: false, configured: false });
  try {
    const { vault, queued } = await demoState(cfg);
    return json({
      ok: true, configured: true, contract: tryContract(), vaultId: cfg.vaultId, agent: cfg.agent, seller: cfg.seller,
      mandate: vault?.mandate ?? null, cap: vault ? formatGen(vault.cap) : null, funds: vault ? formatGen(vault.funds) : null,
      empty: !vault || vault.funds < GEN / BigInt(10), queued, limits: TRY_LIMITS,
    });
  } catch (e) {
    return json({ ok: false, configured: true, error: errText(e) }, 502);
  }
}

export async function POST(request: Request) {
  const cfg = config();
  if (!cfg) return json({ ok: false, error: "Try it is not configured on this deployment." }, 503);
  let body: { action?: unknown; offer?: unknown; offerId?: unknown; terms?: unknown; counterproposal?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "Send JSON." }, 400);
  }
  const action = String(body.action ?? "offer");

  if (action === "offer") {
    const offer = String(body.offer ?? "");
    if (offer.trim().length < TRY_LIMITS.minChars) return json({ ok: false, error: `Write at least ${TRY_LIMITS.minChars} characters.` }, 400);
    if (offer.length > TRY_LIMITS.maxChars) return json({ ok: false, error: `Offers are limited to ${TRY_LIMITS.maxChars} characters (yours has ${offer.length}). Nothing was cut.` }, 400);
    const limit = await overLimit(request, "ip", TRY_LIMITS.perIpPerHour);
    if (limit.blocked) return json({ ok: false, error: `Limit reached: ${TRY_LIMITS.perIpPerHour} tries per hour per network. Each judgment costs validators real work.` }, 429);
    return withLock("seller", async () => {
      try {
        const { vault, queued, events } = await demoState(cfg, false);
        if (!vault) return json({ ok: false, error: "The demo vault was not found on the contract." }, 503);
        const mentioned = offer.match(/(\d+(?:\.\d+)?)\s*GEN\b/i)?.[1];
        const parsed = mentioned ? parseGen(mentioned) : null;
        const amount = parsed && parsed > BigInt(0) ? parsed : parseGen(TRY_LIMITS.defaultAmount)!;
        if (vault.funds < GEN / BigInt(10) || (amount <= vault.cap && amount > vault.funds)) {
          return json({ ok: false, empty: true, error: `The demo vault is nearly empty (${formatGen(vault.funds)} GEN left). The team tops it up; try again later.` }, 503);
        }
        // The contract allows 3 open negotiations per seller per vault. The demo seller closes its oldest
        // open one (not being judged) before posting, and waits until that is recorded.
        const mine = [...buildNegotiations(events).negotiations.values()].filter((n) => n.seller === cfg.seller && n.vaultId === cfg.vaultId && n.status === "OPEN");
        if (mine.length >= 3) {
          const oldest = mine.find((n) => n.latest.status !== "JUDGING");
          if (!oldest) return json({ ok: false, busy: true, error: "The demo seller's negotiations are all being judged. Retrying…" }, 429);
          const closing = await write(cfg.sellerKey, "decline", [oldest.latest.offerId, "Try it: making room for a new visitor"]);
          await waitDecided(cfg.sellerKey, closing);
        }
        const offerId = newId("try");
        const hash = await write(cfg.sellerKey, "post_offer", [offerId, cfg.vaultId, amount, offer]);
        await limit.bump();
        return json({ ok: true, step: "offer", hash, offerId, amount: formatGen(amount), seller: cfg.seller, queuedAhead: queued, contract: tryContract() });
      } catch (e) {
        return json({ ok: false, error: `Submitting to GenLayer failed: ${errText(e)}. Try again in a minute.` }, 502);
      }
    });
  }

  const offerId = String(body.offerId ?? "").trim();
  if (!offerId || offerId.length > 128) return json({ ok: false, error: "Missing offerId." }, 400);
  const limit = await overLimit(request, "step", TRY_LIMITS.perIpPerHour * 4);
  if (limit.blocked) return json({ ok: false, error: "Too many steps from this network in the last hour." }, 429);

  if (action === "request") {
    const terms = String(body.terms ?? "");
    return withLock("agent", async () => {
      try {
        const requestId = newId("try-req");
        const hash = await write(cfg.agentKey, "request_commitment", [requestId, cfg.vaultId, offerId, await termsHash(terms), JUSTIFICATION]);
        await limit.bump();
        return json({ ok: true, step: "request", hash, requestId });
      } catch (e) {
        return json({ ok: false, error: `Submitting to GenLayer failed: ${errText(e)}. Try again in a minute.` }, 502);
      }
    });
  }

  if (action === "accept") {
    const cp = String(body.counterproposal ?? "");
    return withLock("seller", async () => {
      try {
        // Only the demo seller's own offers, and only once per negotiation.
        const { events } = await demoState(cfg, false);
        const offer = buildNegotiations(events).offers.get(offerId);
        if (offer && offer.seller !== cfg.seller) return json({ ok: false, error: "That offer was not posted by the demo seller." }, 403);
        if (offer && offer.version > 1) return json({ ok: false, error: "The demo seller accepts one counterproposal per negotiation." }, 400);
        const newOfferId = newId("try");
        const hash = await write(cfg.sellerKey, "accept_counterproposal", [newOfferId, offerId, cp]);
        await limit.bump();
        return json({ ok: true, step: "accept", hash, offerId: newOfferId });
      } catch (e) {
        return json({ ok: false, error: `Submitting to GenLayer failed: ${errText(e)}. Try again in a minute.` }, 502);
      }
    });
  }
  return json({ ok: false, error: "Unknown action." }, 400);
}
