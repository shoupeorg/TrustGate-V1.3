"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  connectStudioNextWallet,
  discoverWalletProviders,
  walletConnectionErrorMessage,
  type ConnectedWallet,
  type DiscoveredWallet,
} from "@/lib/genlayer";
import { createAgentKey, forgetAgentKey, importAgentKey, loadAgentKey, type AgentKey } from "@/lib/agent-key";
import {
  balanceOf,
  buildLedger,
  createVaultArgs,
  EXPLORER_ADDRESS,
  EXPLORER_TX,
  formatGen,
  GEN,
  isProvisional,
  isSettled,
  mandateCapMismatch,
  MAX_ALLOWLIST,
  MAX_MANDATE,
  newId,
  parseAllowlist,
  parseGen,
  prepareAgentWrite,
  prepareWalletWrite,
  acceptCounterArgs,
  counterOfferArgs,
  offerRequestArgs,
  postOfferArgs,
  submitWrite,
  termsHash,
  transferFee,
  VAULT_CONTRACT,
  VAULT_CONTRACTS,
  ZERO,
  type FeedEvent,
  type Ledger,
  type PreparedWrite,
  type Progress,
  type Vault,
  type VaultRequest,
} from "@/lib/vault";
import { buildNegotiations, type NegotiationBook } from "@/lib/negotiation";
import { TryIt } from "@/components/try-it";
import { BothSides, NegotiationList, NegotiationView, OfferRequests, SellerMode } from "@/components/negotiation";
import { BenchmarkSection, GenLayerHeadline, HowItWorksDiagram, ThreeOptions } from "@/components/genlayer-value";

const MANDATE_TEMPLATES = [
  {
    name: "Research purchases",
    text: "Buy data or compute services for research. Only refundable or escrowed payments. Never pay an address the counterparty supplies at the last minute.",
  },
  {
    name: "SaaS subscriptions",
    text: "Subscribe to software tools the team already uses. Monthly plans only, cancellable at any time, no annual prepayment. Never grant admin or billing access to the provider.",
  },
  {
    name: "Freelance tasks",
    text: "Pay freelancers for clearly scoped tasks with a written deliverable. Payment only after delivery is verified, or into escrow released on delivery. No open-ended retainers.",
  },
];

const AGENT_FUNDING = GEN / BigInt(2); // 0.5 GEN covers about 10 judged requests in fees
const MIN_DEPOSIT = GEN / BigInt(10);
const MAX_DEPOSIT = BigInt(1000) * GEN;
const FEED_TIMEOUT = 45000; // a cold server cache may need one full history download
const SNAPSHOT_KEY = "trustgate.v13.feed.";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
const errorText = (e: unknown) => (e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e)).split("\n")[0];

type Role = "owner" | "agent" | "seller";
type Pending = { label: string; prepared: PreparedWrite; after?: (hash: string) => void };
type Live = { label: string; started: number; progress?: Progress; error?: string };
type FeedState = { events: FeedEvent[]; fetchedAt: string | null; source: string; error: string | null; stale: boolean; loading: boolean };

// ---------------------------------------------------------------- feed (never stuck on "loading")

function useFeed(contract: string) {
  const [state, setState] = useState<FeedState>(() => ({ events: [], fetchedAt: null, source: "", error: null, stale: false, loading: true }));
  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FEED_TIMEOUT);
    try {
      const res = await fetch(`/api/vault-feed?contract=${contract}`, { cache: "no-store", signal: controller.signal });
      const body = (await res.json()) as { events?: FeedEvent[]; error?: string; source?: string; fetchedAt?: string };
      if (!res.ok || body.error || !Array.isArray(body.events)) throw new Error(body.error ?? `HTTP ${res.status}`);
      const next = { events: body.events, fetchedAt: body.fetchedAt ?? new Date().toISOString(), source: body.source ?? "transaction history", error: null, stale: false, loading: false };
      setState(next);
      try {
        window.localStorage.setItem(SNAPSHOT_KEY + contract, JSON.stringify(next));
      } catch {}
    } catch (e) {
      const message = controller.signal.aborted ? `no answer from Studio Next within ${FEED_TIMEOUT / 1000} s` : errorText(e);
      setState((s) => {
        if (s.events.length) return { ...s, error: message, stale: true, loading: false };
        try {
          const cached = JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY + contract) ?? "null") as FeedState | null;
          if (cached?.events?.length) return { ...cached, error: message, stale: true, loading: false };
        } catch {}
        return { ...s, error: message, loading: false };
      });
    } finally {
      window.clearTimeout(timer);
    }
  }, [contract]);

  useEffect(() => {
    const first = window.setTimeout(refresh, 0);
    const t = window.setInterval(refresh, 8000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);
  return { ...state, refresh };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

// ---------------------------------------------------------------- app

export function VaultApp() {
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState<AgentKey | null>(null);
  const [agentBalance, setAgentBalance] = useState<bigint | null>(null);
  const [role, setRole] = useState<Role>("owner");
  const [contract, setContract] = useState<string>(VAULT_CONTRACT);
  const [pending, setPending] = useState<Pending | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [openNeg, setOpenNeg] = useState<string | null>(null);
  const feed = useFeed(contract);
  const now = useNow(Boolean(live && !live.error && live.progress?.phase !== "finalized"));

  useEffect(() => {
    const stop = discoverWalletProviders((found) => setWallets(found));
    const fallback = window.setTimeout(() => setWallets((w) => w ?? []), 1200);
    const restore = window.setTimeout(() => {
      setAgentKey(loadAgentKey());
      // Shareable links: ?negotiation=…[&contract=…]
      const q = new URLSearchParams(window.location.search);
      const c = VAULT_CONTRACTS.find((x) => x.address.toLowerCase() === (q.get("contract") ?? "").toLowerCase());
      if (c) setContract(c.address);
      if (q.get("negotiation")) setOpenNeg(q.get("negotiation"));
    }, 0);
    return () => {
      stop();
      window.clearTimeout(fallback);
      window.clearTimeout(restore);
    };
  }, []);

  const refreshBalances = useCallback(async () => {
    if (wallet) setWalletBalance(await balanceOf(wallet.address).catch(() => null));
    if (agentKey) setAgentBalance(await balanceOf(agentKey.address).catch(() => null));
  }, [wallet, agentKey]);

  useEffect(() => {
    const first = window.setTimeout(refreshBalances, 0);
    const t = window.setInterval(refreshBalances, 15000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refreshBalances]);

  // Follow account / network changes made inside the wallet.
  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      if (!accounts?.length) {
        setWallet(null);
        setWalletError("The wallet was locked or disconnected. Click Connect to continue.");
      } else if (accounts[0].toLowerCase() !== wallet?.address.toLowerCase()) {
        setWallet(null);
        setWalletError("You switched accounts in the wallet. Click Connect again to use the new account.");
      }
    };
    const onChain = (...args: unknown[]) => {
      if (String(args[0]).toLowerCase() !== "0xf22d") setWalletError("Your wallet switched away from GenLayer Studio Next (61997). Click Connect to switch back before signing.");
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet]);

  const ledger: Ledger = useMemo(() => buildLedger(feed.events), [feed.events]);
  const book: NegotiationBook = useMemo(() => buildNegotiations(feed.events), [feed.events]);
  const negotiation = openNeg ? book.negotiations.get(openNeg) ?? null : null;
  const showNegotiation = (id: string) => {
    setOpenNeg(id);
    const url = new URL(window.location.href);
    url.searchParams.set("negotiation", id);
    if (contract !== VAULT_CONTRACTS[0].address) url.searchParams.set("contract", contract);
    else url.searchParams.delete("contract");
    window.history.replaceState(null, "", url.pathname + url.search + "#negotiation");
    window.setTimeout(() => document.getElementById("negotiation")?.scrollIntoView({ behavior: "smooth" }), 50);
  };
  const closeNegotiation = () => {
    setOpenNeg(null);
    window.history.replaceState(null, "", window.location.pathname);
  };
  const current = ledger.vaults.find((v) => v.vaultId === selected) ?? ledger.vaults[0] ?? null;
  const me = wallet?.address.toLowerCase() ?? null;
  const agentAddr = agentKey?.address.toLowerCase() ?? null;
  const readOnly = contract !== VAULT_CONTRACTS[0].address;

  async function connect(w: DiscoveredWallet) {
    setWalletError(null);
    setConnecting(w.name);
    try {
      const connected = await connectStudioNextWallet(w.provider);
      setWallet(connected);
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setWalletError(/valid account/i.test(msg) ? "The wallet returned no account. Unlock it (open the extension and enter your password), then click Connect again." : msg);
    } finally {
      setConnecting(null);
    }
  }

  async function review(label: string, prepare: () => Promise<PreparedWrite>, after?: (hash: string) => void) {
    setBusy(true);
    setLive(null);
    try {
      setPending({ label, prepared: await prepare(), after });
    } catch (e) {
      setLive({ label, started: Date.now(), error: `Could not estimate the fee: ${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    const { label, prepared, after } = pending;
    setPending(null);
    setBusy(true);
    const started = Date.now();
    setLive({ label, started, progress: { phase: "signing" } });
    try {
      const hash = await submitWrite(contract as `0x${string}`, prepared, (progress) => {
        setLive((l) => (l && l.started === started ? { ...l, progress, error: progress.phase === "failed" ? progress.error : undefined } : l));
        if (progress.phase === "decided" || progress.phase === "finalized" || progress.phase === "failed") {
          void feed.refresh();
          void refreshBalances();
        }
      });
      after?.(hash);
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setLive({ label, started, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transaction in the wallet. Nothing was sent." : msg.replace(/^Wallet connection failed: /, "") });
    } finally {
      setBusy(false);
    }
  }

  // Plain GEN transfer from the owner's wallet to the browser agent key, for request fees.
  async function fundAgent(amount: bigint) {
    if (!wallet || !agentKey) return;
    const started = Date.now();
    try {
      const fee = await transferFee(wallet.address, agentKey.address, amount);
      setPending(null);
      setLive({ label: `Send ${formatGen(amount)} GEN to your agent key (network fee ${fee < GEN / BigInt(10000) ? "under 0.0001" : `about ${formatGen(fee)}`} GEN)`, started, progress: { phase: "signing" } });
      const hash = (await wallet.provider.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: agentKey.address, value: `0x${amount.toString(16)}` }],
      } as never)) as string;
      setLive((l) => (l ? { ...l, progress: { phase: "submitted", hash } } : l));
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const bal = await balanceOf(agentKey.address).catch(() => null);
        if (bal !== null && bal >= amount) {
          setAgentBalance(bal);
          setLive((l) => (l ? { ...l, progress: { phase: "finalized", statusName: "CONFIRMED", hash } } : l));
          void refreshBalances();
          return;
        }
      }
      setLive((l) => (l ? { ...l, error: "Sent, but the agent balance has not updated yet. Check the transaction link." } : l));
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setLive({ label: "Fund agent key", started, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transfer in the wallet. Nothing was sent." : msg.replace(/^Wallet connection failed: /, "") });
    }
  }

  const ownerVaults = me ? ledger.vaults.filter((v) => v.owner === me) : [];
  const agentSigner = agentKey ? { kind: "key" as const, address: agentAddr! } : me ? { kind: "wallet" as const, address: me } : null;
  const agentVaults = agentSigner ? ledger.vaults.filter((v) => v.agent === agentSigner.address) : [];
  const agentVault = agentVaults.find((v) => v.vaultId === selected) ?? agentVaults[0] ?? null;

  return (
    <main className="site-shell v13" id="top">
      <header className="site-header">
        <div className="header-left">
          <div className="brand">
            <span aria-hidden="true">TG</span>
            <div><strong>TrustGate V1.3</strong><small>Commitment vault · GenLayer Studio Next</small></div>
          </div>
          <a className="thesis-link" href="/v1">Version 1 <span aria-hidden="true">↗</span></a>
        </div>
        <WalletBar
          wallets={wallets}
          wallet={wallet}
          balance={walletBalance}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={() => {
            setWallet(null);
            setWalletBalance(null);
          }}
          onFunded={refreshBalances}
        />
      </header>
      {walletError && <div className="integration-message error" role="alert">{walletError}</div>}

      <section className="v13-hero" aria-labelledby="hero-title">
        <p className="eyebrow">TrustGate V1.3</p>
        <h1 id="hero-title">Before an Agent Says Yes.</h1>
        <p className="v13-lede">V1 told your agent whether it <em>should</em> say yes. V1.3 makes sure it <em>can&apos;t</em> say yes without TrustGate.</p>
        <div className="v13-tldr">
          <strong>TL;DR</strong>
          <ol>
            <li>You put funds in a TrustGate vault on GenLayer and write what your agent may spend them on, in plain language.</li>
            <li>A seller posts a signed offer to your vault. Your agent can only <em>request</em> a payment for that exact offer. It never holds the money.</li>
            <li>Hard limits are checked instantly. Then GenLayer validators judge the offer against your mandate: ACCEPT credits the seller, RENEGOTIATE sends safer terms to the seller to sign or refuse, REJECT keeps the money locked.</li>
          </ol>
          <p>Why GenLayer: with an AI gate on a server, someone controls the decision over your money. On GenLayer nobody does: the contract holds the funds and independent validators decide.</p>
        </div>
        <GenLayerHeadline />
        <ThreeOptions />
        <HowItWorksDiagram />
        <KeyLimits />
      </section>

      {openNeg && (
        <section className="v13-try" id="negotiation" aria-labelledby="neg-title">
          <p className="eyebrow">Negotiation</p>
          <h2 id="neg-title">One negotiation, both sides, one verdict</h2>
          {negotiation ? (
            <NegotiationView n={negotiation} contract={contract !== VAULT_CONTRACTS[0].address ? contract : undefined} onClose={closeNegotiation} />
          ) : (
            <p className="v13-note">{feed.loading ? "Loading the contract history…" : <>Negotiation <code>{openNeg}</code> is not on this contract yet (a new offer can take a minute to appear). <button className="v13-link" onClick={closeNegotiation}>Close</button></>}</p>
          )}
        </section>
      )}

      <BothSides />

      <TryIt onOpenNegotiation={showNegotiation} />

      <BenchmarkSection />

      <section className="v13-try" aria-labelledby="agents-title">
        <h2 id="agents-title">Who is who: agent vs. judge</h2>
        <div className="v13-role-explain">
          <p><b>The agent is untrusted.</b> It is whatever AI spends on your behalf. In this demo it is either the server-side <em>Try it</em> agent (it forwards text unchanged) or our live LLM agent (<code>scripts/demo-agent.mjs</code>), which reads offers and decides what to request. That LLM agent thinks with GenLayer&apos;s own model through <code>contracts/agent_brain.py</code>, so the demo needs no outside AI provider. It decides nothing about money and can be fooled; that is the point.</p>
          <p><b>The judge is GenLayer.</b> The TrustGate contract holds the funds, checks the hard limits, and asks several independent GenLayer validators to judge each request against your mandate. Money moves only if they agree on ACCEPT. Nobody, including us, controls that decision.</p>
        </div>
      </section>

      <section className="v13-try" aria-labelledby="mcp-title">
        <h2 id="mcp-title">Let a real AI agent use it (MCP)</h2>
        <p className="v13-note">The TrustGate MCP server lets any MCP client (desktop AI apps, agent frameworks) act as either side. <b>Buyer tools:</b> list offers, request commitment (by offer id), get verdict, vault status. <b>Seller tools:</b> post offer, get counterproposal, accept counterproposal, counter offer, decline, get negotiation. It never waits for minutes: slow steps return at once as <em>pending</em>, then the agent polls.</p>
        <ol className="v13-steps">
          <li>In the Owner tab, create an agent key and a vault, then use “Back up or remove this key” to copy the agent key. It is a test key; never use a key that holds real funds.</li>
          <li>Get the code from <a href="https://github.com/shoupeorg/TrustGate-V1.3" target="_blank" rel="noreferrer">github.com/shoupeorg/TrustGate-V1.3</a>, then run <code>cd mcp &amp;&amp; npm install &amp;&amp; npm run build</code>.</li>
          <li>Open the config file of your MCP client (in desktop AI apps it is usually under Settings → Developer → Edit Config), add this, and restart the client:</li>
        </ol>
        <pre className="v13-code">{`{
  "mcpServers": {
    "trustgate": {
      "command": "node",
      "args": ["C:\\\\path\\\\to\\\\Trustgate\\\\mcp\\\\dist\\\\index.js"],
      "env": {
        "TRUSTGATE_AGENT_PRIVATE_KEY": "0x…test agent key (buyer side)…",
        "TRUSTGATE_SELLER_PRIVATE_KEY": "0x…test seller key (seller side)…",
        "TRUSTGATE_CONTRACT": "${VAULT_CONTRACTS[0].address}"
      }
    }
  }
}`}</pre>
        <p className="v13-note">Then ask your agent, for example: “List the open offers on vault my-vault-id and request the dataset one” (buyer), or “Post this offer to vault my-vault-id for 0.5 GEN: …” (seller). Set only the key for the side you play. Keys stay in that config file on your machine; the server never prints or logs them.</p>
      </section>

      {(pending || live) && <TxPanel pending={pending} live={live} now={now} onConfirm={confirm} onCancel={() => setPending(null)} />}

      <section className="v13-roles" aria-labelledby="roles-title">
        <h2 id="roles-title">Use it with your own wallet</h2>
        <div className="v13-role-explain">
          <p><b>Owner</b>: deposits GEN into a vault, writes the mandate and the hard limits, picks which agent may ask for payments. Can top up and take funds back.</p>
          <p><b>Agent</b> (buyer side): the AI (or person) that wants to spend. It can only <em>request</em> payment for a seller&apos;s signed offer; GenLayer validators decide. The vault refuses owner = agent, so to try both roles create an agent key in this browser.</p>
          <p><b>Seller</b>: anyone with a wallet. Posts a signed offer to a vault (and is its payee), sees TrustGate&apos;s counterproposals, and accepts, counters or declines. Use a different account from the owner and the agent.</p>
        </div>
        <div className="v13-tabs" role="tablist" aria-label="Role">
          <button role="tab" aria-selected={role === "owner"} className={role === "owner" ? "active" : ""} onClick={() => setRole("owner")}>Owner</button>
          <button role="tab" aria-selected={role === "agent"} className={role === "agent" ? "active" : ""} onClick={() => setRole("agent")}>Agent (buyer)</button>
          <button role="tab" aria-selected={role === "seller"} className={role === "seller" ? "active" : ""} onClick={() => setRole("seller")}>Seller</button>
        </div>

        {role === "seller" ? (
          readOnly ? (
            <p className="v13-note">This is an older contract without negotiation. Switch the feed below to the current negotiation contract to act as a seller.</p>
          ) : (
            <SellerMode
              me={me}
              vaults={ledger.vaults}
              book={book}
              disabled={busy || !wallet}
              onOpen={showNegotiation}
              onPost={(vaultId, amount, terms) => {
                const offerId = newId("offer");
                review("Post offer", () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "post_offer", postOfferArgs(offerId, vaultId, amount, terms)), () => showNegotiation(offerId));
              }}
              onAccept={(o) => review(`Sign the counterproposal as v${o.version + 1}`, () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "accept_counterproposal", acceptCounterArgs(newId("offer"), o.offerId, o.counterproposal!.dealText)), () => showNegotiation(o.negotiationId))}
              onCounter={(o, amount, terms) => review(`Sign counter offer v${o.version + 1}`, () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "counter_offer", counterOfferArgs(newId("offer"), o.offerId, amount, terms)), () => showNegotiation(o.negotiationId))}
              onDecline={(o, reason) => review("Decline the negotiation", () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "decline", [o.offerId, reason]), () => showNegotiation(o.negotiationId))}
            />
          )
        ) : role === "owner" ? (
          <div className="v13-grid">
            <div className="v13-col">
              <CreateVault
                wallet={wallet}
                balance={walletBalance}
                agentKey={agentKey}
                agentBalance={agentBalance}
                disabled={busy}
                onAgentKey={setAgentKey}
                onFundAgent={fundAgent}
                onSubmit={(id, agent, mandate, cap, totalCap, allowlist, deposit) =>
                  review("Create vault", () => prepareWalletWrite(wallet!.provider, wallet!.address, VAULT_CONTRACT, "create_vault", createVaultArgs(id, agent, mandate, cap, totalCap, allowlist), deposit), () => {
                    setContract(VAULT_CONTRACT);
                    setSelected(id);
                  })}
              />
            </div>
            <div className="v13-col">
              <OwnerVaults
                vaults={ownerVaults}
                wallet={wallet}
                disabled={busy || readOnly}
                onTopUp={(v, amount) => review(`Top up ${v.vaultId}`, () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "top_up", [v.vaultId], amount))}
                onReclaim={(v, amount) => review(`Take ${formatGen(amount)} GEN back from ${v.vaultId}`, () => prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "owner_reclaim", [v.vaultId, amount]))}
              />
              <Credits
                ledger={ledger}
                wallet={wallet}
                agentKey={agentKey}
                disabled={busy || readOnly}
                onWithdraw={(who, amount) =>
                  review(`Withdraw ${formatGen(amount)} GEN`, () =>
                    who === "key" ? prepareAgentWrite(agentKey!.privateKey, "withdraw", [amount]) : prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "withdraw", [amount]))}
              />
            </div>
          </div>
        ) : (
          <div className="v13-grid">
            <div className="v13-col">
              <AgentPanel agentKey={agentKey} agentBalance={agentBalance} wallet={wallet} vaults={agentVaults} vault={agentVault} onSelect={setSelected} />
              {agentVault && agentSigner && !readOnly && (
                <OfferRequests
                  vault={agentVault}
                  book={book}
                  disabled={busy || (agentSigner.kind === "key" && (agentBalance ?? ZERO) === ZERO)}
                  onOpen={showNegotiation}
                  onRequest={(offer, justification) =>
                    review(`Request commitment for offer v${offer.version}`, async () => {
                      const args = offerRequestArgs(newId("req"), agentVault.vaultId, offer.offerId, await termsHash(offer.terms), justification);
                      return agentSigner.kind === "key" ? prepareAgentWrite(agentKey!.privateKey, "request_commitment", args) : prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "request_commitment", args);
                    }, () => showNegotiation(offer.negotiationId))}
                />
              )}
            </div>
            <div className="v13-col">
              <Credits
                ledger={ledger}
                wallet={wallet}
                agentKey={agentKey}
                disabled={busy || readOnly}
                onWithdraw={(who, amount) =>
                  review(`Withdraw ${formatGen(amount)} GEN`, () =>
                    who === "key" ? prepareAgentWrite(agentKey!.privateKey, "withdraw", [amount]) : prepareWalletWrite(wallet!.provider, wallet!.address, contract as `0x${string}`, "withdraw", [amount]))}
              />
            </div>
          </div>
        )}
      </section>

      <section className="v13-feed" aria-labelledby="feed-title">
        <div className="section-row">
          <div><p className="eyebrow">Live feed</p><h2 id="feed-title">Vaults and verdicts</h2></div>
          <FeedStatus feed={feed} count={ledger.vaults.length} />
        </div>
        <div className="v13-tabs" role="tablist" aria-label="Contract">
          {VAULT_CONTRACTS.map((c) => (
            <button key={c.address} role="tab" aria-selected={contract === c.address} className={contract === c.address ? "active" : ""} onClick={() => { setContract(c.address); setSelected(null); }} title={c.note}>
              {c.label}
            </button>
          ))}
        </div>
        <p className="v13-note">Contract <a href={EXPLORER_ADDRESS + contract} target="_blank" rel="noreferrer"><code>{contract}</code></a>. {VAULT_CONTRACTS.find((c) => c.address === contract)?.note}</p>
        {feed.error && (
          <div className="integration-message error" role="status">
            Studio Next history did not load ({feed.error}). {feed.stale ? "Showing the last good snapshot." : ""} Retrying every 8 seconds. <button className="v13-link" onClick={() => void feed.refresh()}>Retry now</button>
          </div>
        )}
        {ledger.vaults.length > 1 && (
          <div className="v13-tabs v13-vault-tabs">
            {ledger.vaults.map((v) => (
              <button key={v.vaultId} className={v.vaultId === current?.vaultId ? "active" : ""} onClick={() => setSelected(v.vaultId)}>{v.vaultId}</button>
            ))}
          </div>
        )}
        {current ? (
          <VaultView vault={current} book={book} onOpen={showNegotiation} />
        ) : feed.loading ? (
          <p className="v13-note">Loading the contract history from Studio Next…</p>
        ) : !feed.error ? (
          <p className="v13-note">No vaults on this contract yet. Connect a wallet and create one.</p>
        ) : null}
      </section>

      <section className="v13-limits" aria-labelledby="limits-title">
        <h2 id="limits-title" className="eyebrow">Limits, stated plainly</h2>
        <ul>
          <li><b>A wrong ACCEPT is possible.</b> The hard per-commitment cap (and the optional total cap) bounds the maximum loss.</li>
          <li><b>A seller who never answers</b> leaves the negotiation open; no funds move, and the owner or agent can withdraw from it. Offers and verdicts are public on-chain.</li>
          <li><b>Mandate quality matters.</b> Start from a template. Only the numeric limits are enforced deterministically; everything written in the mandate is judged by validators.</li>
          <li><b>Minutes, not milliseconds.</b> Each judged request takes a few minutes. Hard-limit rejections are instant.</li>
          <li><b>Payouts on Studio Next:</b> ACCEPT credits the payee inside the vault. Withdrawing that credit to a wallet did not deliver GEN on chain 61997 in our tests (the call succeeds, the transfer does not arrive). See <a href="https://github.com/shoupeorg/TrustGate-V1.3/blob/main/experiments/PAYOUT_INVESTIGATION.md" target="_blank" rel="noreferrer">payout investigation</a>.</li>
          <li><b>Studio Next only.</b> Contract reads were failing there during development, so this page rebuilds vault state from the transaction history.</li>
        </ul>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- wallet

function WalletBar({ wallets, wallet, balance, connecting, onConnect, onDisconnect, onFunded }: {
  wallets: DiscoveredWallet[] | null; wallet: ConnectedWallet | null; balance: bigint | null; connecting: string | null;
  onConnect: (w: DiscoveredWallet) => void; onDisconnect: () => void; onFunded: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    const t = window.setTimeout(() => setSlow(true), 12000);
    return () => {
      window.clearTimeout(t);
      setSlow(false);
    };
  }, [connecting]);

  if (wallet) {
    return (
      <div className="header-actions v13-wallet">
        <div className="status-badge"><i />{short(wallet.address)} · {balance === null ? "…" : `${formatGen(balance)} GEN`}</div>
        <Faucet address={wallet.address} onDone={onFunded} />
        <button className="wallet-button" onClick={onDisconnect}>Disconnect</button>
      </div>
    );
  }
  if (wallets === null) return <div className="header-actions"><div className="status-badge">Looking for wallets…</div></div>;
  if (wallets.length === 0) {
    return (
      <div className="header-actions v13-wallet">
        <div className="v13-nowallet" role="note">
          <b>No browser wallet found.</b> Install <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noreferrer">Rabby</a>, reload this page, then click Connect. The GenLayer Studio Next network (chain 61997) is added automatically. No wallet? Use <a href="#try-it">Try it</a> below.
        </div>
      </div>
    );
  }
  return (
    <div className="header-actions v13-wallet">
      {wallets.slice(0, 3).map((w) => (
        <button key={w.id} className="wallet-button" onClick={() => onConnect(w)} disabled={Boolean(connecting)}>
          <span><b>{connecting === w.name ? "Approve in wallet…" : `Connect ${w.name}`}</b><small>Studio Next · 61997</small></span>
        </button>
      ))}
      {connecting && slow && <p className="v13-hint" role="status">No popup? Click the {connecting} icon in your browser toolbar. It may be waiting for you to unlock it or approve the network.</p>}
    </div>
  );
}

function Faucet({ address, onDone }: { address: string; onDone: () => void }) {
  const [state, setState] = useState<{ busy: boolean; msg: string | null; error: boolean; hash?: string }>({ busy: false, msg: null, error: false });
  async function claim() {
    setState({ busy: true, msg: "Sending test GEN…", error: false });
    try {
      const res = await fetch("/api/test-gen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      const body = (await res.json()) as { ok: boolean; error?: string; amount?: string; hash?: string; confirmed?: boolean };
      if (!body.ok) return setState({ busy: false, msg: body.error ?? "Faucet error.", error: true });
      setState({ busy: false, msg: `${body.amount} test GEN sent${body.confirmed ? "" : " (confirming…)"}.`, error: false, hash: body.hash });
      onDone();
      window.setTimeout(onDone, 6000);
    } catch (e) {
      setState({ busy: false, msg: `Faucet unreachable: ${errorText(e)}`, error: true });
    }
  }
  return (
    <div className="v13-faucet">
      <button className="faucet-button" onClick={claim} disabled={state.busy}>{state.busy ? "Sending…" : "Get test GEN"}</button>
      {state.msg && (
        <small className={state.error ? "v13-error" : "v13-ok"} role="status">
          {state.msg} {state.hash && <a href={EXPLORER_TX + state.hash} target="_blank" rel="noreferrer">tx ↗</a>}
        </small>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- transactions

const PHASE_TEXT: Record<Progress["phase"], string> = {
  signing: "Waiting for your signature…",
  submitted: "Submitted. Waiting for the network to pick it up…",
  pending: "Queued on Studio Next…",
  processing: "GenLayer validators are executing / judging it…",
  decided: "Consensus reached (provisional). Waiting for finalization…",
  finalized: "Finalized.",
  failed: "No verdict.",
};

function TxPanel({ pending, live, now, onConfirm, onCancel }: { pending: Pending | null; live: Live | null; now: number; onConfirm: () => void; onCancel: () => void }) {
  if (pending) {
    const p = pending.prepared;
    return (
      <section className="integration-message pending v13-tx" aria-live="polite">
        <span>
          <b>{pending.label}.</b> Network fee up to <b>{formatGen(p.fee)} GEN</b> (unused fee is refunded)
          {p.value > ZERO ? <> + deposit <b>{formatGen(p.value)} GEN</b></> : null}.{" "}
          {p.via === "agentKey" ? "Signed by your browser agent key (no wallet popup)." : "Your wallet will ask you to confirm."}
        </span>
        <span className="v13-actions"><button onClick={onConfirm}>{p.via === "agentKey" ? "Confirm and send" : "Confirm in wallet"}</button><button onClick={onCancel}>Cancel</button></span>
      </section>
    );
  }
  if (!live) return null;
  const secs = Math.max(0, Math.floor(((live.progress?.phase === "finalized" ? now : now) - live.started) / 1000));
  return (
    <section className={`integration-message ${live.error ? "error" : "submitted"} v13-tx`} aria-live="polite">
      <span className="transaction-identifiers">
        <span><b>{live.label}</b>: {live.error ?? PHASE_TEXT[live.progress?.phase ?? "signing"]} {!live.error && live.progress?.phase !== "finalized" && <span className="v13-elapsed">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} elapsed</span>}</span>
        {live.progress?.hash && <a href={EXPLORER_TX + live.progress.hash} target="_blank" rel="noreferrer"><code>{live.progress.hash}</code> ↗</a>}
      </span>
    </section>
  );
}

// ---------------------------------------------------------------- owner

function CreateVault({ wallet, balance, agentKey, agentBalance, disabled, onAgentKey, onFundAgent, onSubmit }: {
  wallet: ConnectedWallet | null; balance: bigint | null; agentKey: AgentKey | null; agentBalance: bigint | null; disabled: boolean;
  onAgentKey: (k: AgentKey | null) => void; onFundAgent: (amount: bigint) => void;
  onSubmit: (id: string, agent: string, mandate: string, cap: bigint, totalCap: bigint, allowlist: string[], deposit: bigint) => void;
}) {
  const [agentMode, setAgentMode] = useState<"key" | "external">("key");
  const [external, setExternal] = useState("");
  const [mandate, setMandate] = useState(MANDATE_TEMPLATES[0].text);
  const [templateAsk, setTemplateAsk] = useState<number | null>(null);
  const [cap, setCap] = useState("2");
  const [totalCap, setTotalCap] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [deposit, setDeposit] = useState("1");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [importText, setImportText] = useState("");
  const capWei = parseGen(cap);
  const totalWei = totalCap.trim() === "" ? ZERO : parseGen(totalCap);
  const depositWei = parseGen(deposit);
  const allow = parseAllowlist(allowlistText);
  const agent = agentMode === "key" ? agentKey?.address ?? "" : external.trim();
  const capMismatch = mandateCapMismatch(mandate, capWei);
  const isTemplate = MANDATE_TEMPLATES.some((t) => t.text === mandate);

  const errors = [
    !wallet && "Connect a wallet first (top right).",
    agentMode === "key" && !agentKey && "Create the agent key below, or switch to an external agent address.",
    agentMode === "external" && !isAddress(external) && "Agent must be a wallet address (0x + 40 hex characters).",
    wallet && agent && agent.toLowerCase() === wallet.address.toLowerCase() && "The agent must be a different address from your wallet (the vault refuses owner = agent).",
    mandate.trim() === "" && "Write a mandate.",
    mandate.length > MAX_MANDATE && `Mandate is ${mandate.length - MAX_MANDATE} characters too long.`,
    (capWei === null || capWei <= ZERO) && "Hard cap must be a positive GEN amount (up to 18 decimals).",
    totalWei === null && "Total spend cap must be a GEN amount or empty.",
    totalWei !== null && totalWei > ZERO && capWei !== null && totalWei < capWei && "Total spend cap is lower than the per-commitment cap.",
    allow.invalid.length > 0 && `Not an address: ${allow.invalid[0]}`,
    allow.addresses.length > MAX_ALLOWLIST && `At most ${MAX_ALLOWLIST} allowlisted payees.`,
    agent && allow.addresses.includes(agent.toLowerCase()) && "The agent cannot be on the payee allowlist.",
    (depositWei === null || depositWei < MIN_DEPOSIT) && `Deposit must be at least ${formatGen(MIN_DEPOSIT)} GEN.`,
    depositWei !== null && depositWei > MAX_DEPOSIT && `Deposit is limited to ${formatGen(MAX_DEPOSIT)} GEN on this test site.`,
    depositWei !== null && balance !== null && depositWei >= balance && `Your wallet has ${formatGen(balance)} GEN; keep some for fees. Use "Get test GEN".`,
  ].filter(Boolean) as string[];

  function pickTemplate(i: number) {
    if (isTemplate || mandate.trim() === "") return setMandate(MANDATE_TEMPLATES[i].text);
    setTemplateAsk(i);
  }

  return (
    <form className="v13-card" onSubmit={(e) => { e.preventDefault(); if (!errors.length && capWei && depositWei && totalWei !== null) onSubmit(newId("vault"), agent, mandate.trim(), capWei, totalWei, allow.addresses, depositWei); }}>
      <p className="eyebrow">Owner</p>
      <h3>Create a vault</h3>

      <fieldset className="v13-fieldset">
        <legend>Who may request payments (the agent)</legend>
        <label className="v13-radio"><input type="radio" checked={agentMode === "key"} onChange={() => setAgentMode("key")} /> An agent key generated in this browser (to try the Agent role yourself)</label>
        <label className="v13-radio"><input type="radio" checked={agentMode === "external"} onChange={() => setAgentMode("external")} /> Another agent&apos;s address</label>
        {agentMode === "key" ? (
          agentKey ? (
            <div className="v13-agentkey">
              <p>Agent key <a href={EXPLORER_ADDRESS + agentKey.address} target="_blank" rel="noreferrer"><code>{agentKey.address}</code></a> · {agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`}</p>
              {(agentBalance ?? ZERO) < GEN / BigInt(5) && (
                <button type="button" className="v13-secondary" disabled={!wallet || disabled} onClick={() => onFundAgent(AGENT_FUNDING)}>
                  Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees
                </button>
              )}
              <details>
                <summary>Back up or remove this key</summary>
                <p className="v13-warn">Test only. The key is stored unencrypted in this browser&apos;s local storage. Anyone with access to this browser profile can use it. Never put real funds on it.</p>
                {showKey ? <code className="v13-secret">{agentKey.privateKey}</code> : <button type="button" className="v13-link" onClick={() => setShowKey(true)}>Show private key for backup</button>}
                <button type="button" className="v13-link" onClick={() => { forgetAgentKey(); onAgentKey(null); setShowKey(false); }}>Remove key from this browser</button>
              </details>
            </div>
          ) : (
            <div className="v13-agentkey">
              <p className="v13-warn">This creates a test-only wallet whose key stays in this browser (local storage, unencrypted). Back it up if you want to keep it. Never use it for real funds.</p>
              <button type="button" className="v13-secondary" onClick={() => { try { onAgentKey(createAgentKey()); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Create agent key</button>
              <details>
                <summary>Restore a backed-up agent key</summary>
                <input aria-label="Agent private key" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="0x… (64 hex characters)" spellCheck={false} autoComplete="off" />
                <button type="button" className="v13-link" onClick={() => { try { onAgentKey(importAgentKey(importText)); setImportText(""); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Restore</button>
              </details>
              {keyError && <p className="v13-error">{keyError}</p>}
            </div>
          )
        ) : (
          <label>Agent wallet address<input value={external} onChange={(e) => setExternal(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
        )}
      </fieldset>

      <label>
        <span className="v13-label-row">Mandate (judged by GenLayer validators) <Counter value={mandate.length} max={MAX_MANDATE} /></span>
        <textarea rows={4} value={mandate} onChange={(e) => setMandate(e.target.value)} />
      </label>
      <div className="v13-templates" role="group" aria-label="Mandate templates">{MANDATE_TEMPLATES.map((t, i) => <button type="button" key={t.name} onClick={() => pickTemplate(i)}>{t.name}</button>)}</div>
      {templateAsk !== null && (
        <p className="v13-confirm" role="alert">
          Replace your mandate text with the “{MANDATE_TEMPLATES[templateAsk].name}” template?{" "}
          <button type="button" className="v13-link" onClick={() => { setMandate(MANDATE_TEMPLATES[templateAsk].text); setTemplateAsk(null); }}>Replace</button>{" "}
          <button type="button" className="v13-link" onClick={() => setTemplateAsk(null)}>Keep mine</button>
        </p>
      )}

      <div className="v13-row">
        <label>Hard cap per commitment, enforced (GEN)<input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" /></label>
        <label>Deposit (GEN){balance !== null && <small> · wallet {formatGen(balance)}</small>}<input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></label>
      </div>
      {capMismatch && <p className="v13-warn">Your mandate mentions {capMismatch} GEN, but the enforced hard cap is {cap} GEN. Only the hard cap is checked deterministically; the text is judged by validators.</p>}
      <details className="v13-optional">
        <summary>Optional enforced limits</summary>
        <label>Total spend cap for the vault (GEN, empty = none)<input value={totalCap} onChange={(e) => setTotalCap(e.target.value)} inputMode="decimal" placeholder="e.g. 10" /></label>
        <label>Payee allowlist (addresses separated by commas or new lines, empty = any payee)<textarea rows={2} value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} spellCheck={false} /></label>
      </details>
      <p className="v13-note">Enforced instantly by the contract: hard cap {capWei ? formatGen(capWei) : "?"} GEN per commitment{totalWei && totalWei > ZERO ? `, ${formatGen(totalWei)} GEN in total` : ", no total cap"}{allow.addresses.length ? `, ${allow.addresses.length} allowlisted payee(s)` : ", any payee"}. Everything else in the mandate is judged by validators.</p>
      {errors.length > 0 && <p className="v13-error" role="status">{errors[0]}</p>}
      <button className="v13-primary" disabled={disabled || errors.length > 0}>Review fee and create vault</button>
    </form>
  );
}

function OwnerVaults({ vaults, wallet, disabled, onTopUp, onReclaim }: { vaults: Vault[]; wallet: ConnectedWallet | null; disabled: boolean; onTopUp: (v: Vault, amount: bigint) => void; onReclaim: (v: Vault, amount: bigint) => void }) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  if (!wallet) return null;
  return (
    <div className="v13-card">
      <p className="eyebrow">Owner</p>
      <h3>Your vaults</h3>
      {vaults.length === 0 && <p className="v13-note">You have no vaults on this contract yet.</p>}
      {vaults.map((v) => {
        const amount = parseGen(amounts[v.vaultId] ?? "1");
        return (
          <div key={v.vaultId} className="v13-ownervault">
            <p><b>{v.vaultId}</b> · holds {formatGen(v.funds)} GEN · credited to payees {formatGen(v.released)} GEN · agent {short(v.agent)}</p>
            <div className="v13-row v13-inline">
              <input aria-label={`Amount for ${v.vaultId}`} value={amounts[v.vaultId] ?? "1"} onChange={(e) => setAmounts({ ...amounts, [v.vaultId]: e.target.value })} inputMode="decimal" />
              <button type="button" className="v13-secondary" disabled={disabled || !amount || amount <= ZERO} onClick={() => amount && onTopUp(v, amount)}>Top up</button>
              <button type="button" className="v13-secondary" disabled={disabled || !amount || amount <= ZERO || amount > v.funds} onClick={() => amount && onReclaim(v, amount)}>Take back</button>
            </div>
          </div>
        );
      })}
      <p className="v13-note">“Take back” moves GEN from the vault to your credit inside the contract; withdraw it below.</p>
    </div>
  );
}

function Credits({ ledger, wallet, agentKey, disabled, onWithdraw }: { ledger: Ledger; wallet: ConnectedWallet | null; agentKey: AgentKey | null; disabled: boolean; onWithdraw: (who: "wallet" | "key", amount: bigint) => void }) {
  const [lookup, setLookup] = useState("");
  const rows: Array<{ who: "wallet" | "key" | "lookup"; label: string; address: string }> = [];
  if (wallet) rows.push({ who: "wallet", label: "Your wallet", address: wallet.address.toLowerCase() });
  if (agentKey) rows.push({ who: "key", label: "Your agent key", address: agentKey.address.toLowerCase() });
  if (isAddress(lookup)) rows.push({ who: "lookup", label: "Looked-up address", address: lookup.trim().toLowerCase() });
  return (
    <div className="v13-card">
      <p className="eyebrow">Payee</p>
      <h3>Credit inside TrustGate</h3>
      <p className="v13-warn">ACCEPT credits the payee <b>inside the vault contract</b>. Withdrawing to a wallet sends a GenLayer transfer that, on Studio Next (61997), has not arrived in our tests. The button works; the GEN may not show up in the wallet.</p>
      {rows.map((r) => {
        const credit = ledger.credits.get(r.address) ?? ZERO;
        return (
          <p key={r.who + r.address} className="v13-credit">
            {r.label} <code>{short(r.address)}</code>: <b>{formatGen(credit)} GEN</b>{" "}
            {r.who !== "lookup" && credit > ZERO && <button type="button" className="v13-secondary" disabled={disabled} onClick={() => onWithdraw(r.who as "wallet" | "key", credit)}>Withdraw all</button>}
          </p>
        );
      })}
      <label>Check any payee address<input value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
      {ledger.withdrawals.length > 0 && <p className="v13-note">{ledger.withdrawals.length} withdraw call(s) on this contract so far.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- agent

function AgentPanel({ agentKey, agentBalance, wallet, vaults, vault, onSelect }: { agentKey: AgentKey | null; agentBalance: bigint | null; wallet: ConnectedWallet | null; vaults: Vault[]; vault: Vault | null; onSelect: (id: string) => void }) {
  const signer = agentKey ? `your browser agent key ${short(agentKey.address)} (${agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`})` : wallet ? `your connected wallet ${short(wallet.address)}` : null;
  return (
    <div className="v13-card">
      <p className="eyebrow">Agent</p>
      <h3>Act as the agent</h3>
      {!signer ? (
        <p className="v13-note">Create an agent key in the Owner tab (or connect the agent&apos;s wallet) to submit requests.</p>
      ) : (
        <>
          <p className="v13-note">Signing as {signer}.</p>
          {agentKey && (agentBalance ?? ZERO) === ZERO && <p className="v13-warn">The agent key has no GEN for fees. In the Owner tab, click “Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees”.</p>}
          {vaults.length === 0 ? (
            <p className="v13-note">No vault on this contract lists this address as its agent yet. Create one in the Owner tab.</p>
          ) : (
            <label>Vault<select value={vault?.vaultId} onChange={(e) => onSelect(e.target.value)}>{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.vaultId} · {formatGen(v.funds)} GEN</option>)}</select></label>
          )}
        </>
      )}
    </div>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return <small className={value > max ? "v13-over" : ""} aria-live="polite">{value.toLocaleString()} / {max.toLocaleString()}</small>;
}

// ---------------------------------------------------------------- feed views

function FeedStatus({ feed, count }: { feed: FeedState; count: number }) {
  const time = feed.fetchedAt ? new Date(feed.fetchedAt).toLocaleTimeString() : null;
  return (
    <span className="v13-feedstatus">
      {feed.loading && !time ? "loading…" : `${count} vault${count === 1 ? "" : "s"}`}
      {time && ` · updated ${time}${feed.stale ? " (stale)" : ""}`}
      {feed.source && ` · source: ${feed.source}`}
    </span>
  );
}

export function KeyLimits() {
  return (
    <ul className="v13-keylimits" aria-label="Key limitations">
      <li>Each judged request takes <b>a few minutes</b>.</li>
      <li>A wrong ACCEPT is possible; the <b>hard cap bounds the loss</b>.</li>
      <li>ACCEPT <b>credits the payee inside the vault</b>; wallet payouts don&apos;t arrive on Studio Next yet.</li>
      <li><b>Studio Next (chain 61997) only</b>, test GEN.</li>
      <li>A seller&apos;s signature proves it <b>controls the payee wallet, not who it is</b>.</li>
      <li>Contract reads (<code>gen_call</code>) failed on Studio Next during development; this page <b>rebuilds state from the transaction history</b>.</li>
    </ul>
  );
}

function VaultView({ vault, book, onOpen }: { vault: Vault; book: NegotiationBook; onOpen: (id: string) => void }) {
  return (
    <div className="v13-vault">
      <div className="v13-vault-head">
        <div><small>Vault</small><b>{vault.vaultId}</b></div>
        <div><small>Holds</small><b>{formatGen(vault.funds)} GEN</b></div>
        <div><small>Credited to payees</small><b>{formatGen(vault.released)} GEN</b></div>
        <div><small>Hard cap (enforced)</small><b>{formatGen(vault.cap)} GEN</b></div>
        {vault.totalCap > ZERO && <div><small>Total cap (enforced)</small><b>{formatGen(vault.totalCap)} GEN</b></div>}
      </div>
      <p className="v13-mandate"><small>Mandate (judged by validators)</small>{vault.mandate}</p>
      <p className="v13-note">
        Owner <a href={EXPLORER_ADDRESS + vault.owner} target="_blank" rel="noreferrer">{short(vault.owner)}</a> · Agent <a href={EXPLORER_ADDRESS + vault.agent} target="_blank" rel="noreferrer">{short(vault.agent)}</a>
        {vault.allowlist.length > 0 && <> · Payee allowlist: {vault.allowlist.map(short).join(", ")}</>}
        {" · "}Credits are held inside the vault; wallet payouts don&apos;t arrive on Studio Next yet.
      </p>
      <NegotiationList book={book} vaultId={vault.vaultId} onOpen={onOpen} />
      {vault.requests.length === 0 && <p className="v13-note">No requests yet.</p>}
      {[...vault.requests].reverse().map((r) => <RequestCard key={r.event.hash} r={r} onOpen={onOpen} />)}
    </div>
  );
}

function RequestCard({ r, onOpen }: { r: VaultRequest; onOpen: (id: string) => void }) {
  const j = r.event.judgment;
  const verdict = r.stage === "GENLAYER" ? j!.decision : r.stage === "DETERMINISTIC" ? "REJECT" : r.stage === "FAILED" ? "FAILED" : r.stage === "UNDETERMINED" ? "NO VERDICT" : "JUDGING";
  const tone = verdict === "ACCEPT" ? "low" : verdict === "RENEGOTIATE" ? "medium" : verdict === "JUDGING" ? "pending" : "high";
  const finality = isSettled(r.event.status) ? "Final" : isProvisional(r.event.status) ? "Provisional · finalizing" : r.event.status.toLowerCase();
  const votes = Object.entries(r.event.votes).map(([k, n]) => `${n} ${k}`).join(" · ");

  return (
    <article className={`v13-request tone-${tone}`}>
      <header>
        <span className="v13-verdict">{verdict}</span>
        <span>{formatGen(r.amount)} GEN → {short(r.payee)}</span>
        <span className="v13-finality">{finality}</span>
      </header>
      {r.parentId && <p className="v13-note">Revision of <code>{r.parentId}</code></p>}
      {r.negotiationId && <p className="v13-note">Offer v{r.offerVersion} signed by the seller · <button className="v13-link" onClick={() => onOpen(r.negotiationId!)}>open negotiation {r.negotiationId}</button></p>}
      <details>
        <summary>Deal text</summary>
        <p className="v13-deal">{r.dealText}</p>
        {r.justification && <p className="v13-note">Agent says: {r.justification}</p>}
      </details>
      {r.stage === "GENLAYER" && j && (
        <>
          <p className="v13-summary"><b>{j.risk} risk · {j.confidence} confidence.</b> {j.summary}</p>
          {j.mandate_violations.length > 0 && (
            <ul className="v13-violations">
              {j.mandate_violations.map((v, i) => <li key={i}><b>{v.rule}</b><span>{v.evidence}</span><small>{v.explanation}</small></li>)}
            </ul>
          )}
          {j.decision === "RENEGOTIATE" && j.counterproposal.deal_text && (
            <div className="v13-counter">
              <small>TrustGate counterproposal</small>
              <p>{j.counterproposal.deal_text}</p>
              {j.counterproposal.notes && <p className="v13-note">{j.counterproposal.notes}</p>}
              {r.negotiationId && <p className="v13-note">Sent to the seller, who can accept it (signing it as a new version), counter, or decline.</p>}
            </div>
          )}
          <p className="v13-note">{r.released ? `ACCEPT: ${formatGen(r.amount)} GEN credited to the ${r.negotiationId ? "seller" : "payee"} inside the vault.` : "Funds stay locked in the vault."}</p>
        </>
      )}
      {r.stage === "DETERMINISTIC" && <p className="v13-summary"><b>Blocked by the enforced hard limits, before any judgment.</b> {r.reasons.join("; ") || "A deterministic check failed."}</p>}
      {r.stage === "FAILED" && <p className="v13-summary">The transaction failed before a verdict (for example, the caller is not the registered agent, or the request id was reused).</p>}
      {r.stage === "UNDETERMINED" && <p className="v13-summary">Validators did not reach a verdict ({r.event.status}). No funds moved. Submitting again starts a new judgment.</p>}
      {r.stage === "PENDING" && <p className="v13-summary">GenLayer validators are judging this request against the mandate. This takes a few minutes.</p>}
      <footer>
        <a href={EXPLORER_TX + r.event.hash} target="_blank" rel="noreferrer">View transaction ↗</a>
        {votes && <span>Validators: {votes}</span>}
      </footer>
    </article>
  );
}
