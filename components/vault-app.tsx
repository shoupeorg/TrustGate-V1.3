"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { NegotiationList, NegotiationView, OfferRequests, SellerMode } from "@/components/negotiation";
import { BenchmarkPane, headlineNumbers } from "@/components/genlayer-value";
import { startLanding } from "@/components/landing/engine";
import { hudText, MandateLines } from "@/components/landing/hud";

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
const REPO = "https://github.com/shoupeorg/TrustGate-V1.3";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
const errorText = (e: unknown) => (e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e)).split("\n")[0];

type Role = "owner" | "agent" | "seller";
type MainTab = "try" | "wallet" | "mcp" | "feed" | "bench";
type Pending = { label: string; prepared: PreparedWrite; after?: (hash: string) => void };
type Live = { label: string; started: number; progress?: Progress; error?: string };
type FeedState = { events: FeedEvent[]; fetchedAt: string | null; source: string; error: string | null; stale: boolean; loading: boolean };
type Where = "header" | "pane";
type Pop = { where: Where; kind: "picker" | "nowallet" | "account" | "looking" } | null;
type FaucetState = { where: Where; busy: boolean; msg: string | null; error: boolean; hash?: string };

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

const Corners = () => (
  <>
    <i className="k tl" />
    <i className="k tr" />
    <i className="k bl" />
    <i className="k br" />
  </>
);

// ---------------------------------------------------------------- app

export function VaultApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [wallets, setWallets] = useState<DiscoveredWallet[] | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [pop, setPop] = useState<Pop>(null);
  const [faucet, setFaucet] = useState<FaucetState | null>(null);
  const [faucetQueued, setFaucetQueued] = useState<Where | null>(null);
  const [agentKey, setAgentKey] = useState<AgentKey | null>(null);
  const [agentBalance, setAgentBalance] = useState<bigint | null>(null);
  const [tab, setTab] = useState<MainTab>("try");
  const [role, setRole] = useState<Role>("owner");
  const [contract, setContract] = useState<string>(VAULT_CONTRACT);
  const [pending, setPending] = useState<Pending | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [openNeg, setOpenNeg] = useState<string | null>(null);
  const feed = useFeed(contract);
  const now = useNow(Boolean(live && !live.error && live.progress?.phase !== "finalized"));
  const txRef = useRef<HTMLDivElement>(null);

  // Scene, HUD panels, header dust and sound.
  useEffect(() => {
    if (!rootRef.current) return;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
    window.scrollTo(0, 0);
    const onShow = () => window.scrollTo(0, 0);
    window.addEventListener("pageshow", onShow);
    const stop = startLanding(rootRef.current);
    return () => {
      stop();
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

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

  // The header turns to dust on scroll; its popover goes with it.
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > window.innerHeight * 0.3) setPop((p) => (p?.where === "header" ? null : p));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
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
        setWalletError("The wallet was locked or disconnected · click Connect wallet to continue");
      } else if (accounts[0].toLowerCase() !== wallet?.address.toLowerCase()) {
        setWallet(null);
        setWalletError("You switched accounts in the wallet · click Connect wallet again to use the new account");
      }
    };
    const onChain = (...args: unknown[]) => {
      if (String(args[0]).toLowerCase() !== "0xf22d") setWalletError("Your wallet switched away from GenLayer Studio Next (61997) · click Connect wallet to switch back before signing");
    };
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet]);

  // Keep the fee review and the transaction status in view.
  const txKey = pending ? `p:${pending.label}` : live ? `l:${live.label}:${live.started}` : "";
  useEffect(() => {
    if (txKey) txRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [txKey]);

  const ledger: Ledger = useMemo(() => buildLedger(feed.events), [feed.events]);
  const book: NegotiationBook = useMemo(() => buildNegotiations(feed.events), [feed.events]);
  const negotiation = openNeg ? book.negotiations.get(openNeg) ?? null : null;
  const showNegotiation = (id: string) => {
    setOpenNeg(id);
    const url = new URL(window.location.href);
    url.searchParams.set("negotiation", id);
    if (contract !== VAULT_CONTRACTS[0].address) url.searchParams.set("contract", contract);
    else url.searchParams.delete("contract");
    window.history.replaceState(null, "", url.pathname + url.search);
  };
  const closeNegotiation = () => {
    setOpenNeg(null);
    window.history.replaceState(null, "", window.location.pathname);
  };
  useEffect(() => {
    if (!openNeg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenNeg(null);
        window.history.replaceState(null, "", window.location.pathname);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNeg]);
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
      setPop(null);
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setWalletError(/valid account/i.test(msg) ? "The wallet returned no account · unlock it (open the extension and enter your password), then click Connect wallet again" : msg);
      setFaucetQueued(null);
    } finally {
      setConnecting(null);
    }
  }

  function openConnect(where: Where) {
    setWalletError(null);
    if (wallet) return setPop(pop?.kind === "account" && pop.where === where ? null : { where, kind: "account" });
    if (wallets === null) return setPop({ where, kind: "looking" });
    if (wallets.length === 0) return setPop(pop?.kind === "nowallet" && pop.where === where ? null : { where, kind: "nowallet" });
    if (wallets.length === 1) {
      setPop({ where, kind: "picker" });
      return void connect(wallets[0]);
    }
    setPop(pop?.kind === "picker" && pop.where === where ? null : { where, kind: "picker" });
  }

  const claim = useCallback(async (where: Where, address: string) => {
    setFaucet({ where, busy: true, msg: "Sending test GEN…", error: false });
    try {
      const res = await fetch("/api/test-gen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      const body = (await res.json()) as { ok: boolean; error?: string; amount?: string; hash?: string; confirmed?: boolean };
      if (!body.ok) return setFaucet({ where, busy: false, msg: body.error ?? "Faucet error", error: true });
      setFaucet({ where, busy: false, msg: `${body.amount} test GEN sent${body.confirmed ? "" : " · confirming…"}`, error: false, hash: body.hash });
      void refreshBalances();
      window.setTimeout(() => void refreshBalances(), 6000);
    } catch (e) {
      setFaucet({ where, busy: false, msg: `Faucet unreachable: ${errorText(e)}`, error: true });
    }
  }, [refreshBalances]);

  function getTestGen(where: Where) {
    if (wallet) return void claim(where, wallet.address);
    // No wallet yet: connect first, then claim for the connected address.
    setFaucetQueued(where);
    setFaucet({ where, busy: false, msg: "Connect a wallet first · test GEN is sent to the connected address", error: false });
    openConnect(where);
  }
  useEffect(() => {
    if (!wallet || !faucetQueued) return;
    const where = faucetQueued;
    const t = window.setTimeout(() => {
      setFaucetQueued(null);
      void claim(where, wallet.address);
    }, 0);
    return () => window.clearTimeout(t);
  }, [wallet, faucetQueued, claim]);

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
      setLive({ label, started, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transaction in the wallet · nothing was sent" : msg.replace(/^Wallet connection failed: /, "") });
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
      setLive((l) => (l ? { ...l, error: "Sent, but the agent balance has not updated yet · check the transaction link" } : l));
    } catch (e) {
      const msg = walletConnectionErrorMessage(e);
      setLive({ label: "Fund agent key", started, error: /rejected|denied|4001/i.test(msg) ? "You rejected the transfer in the wallet · nothing was sent" : msg.replace(/^Wallet connection failed: /, "") });
    }
  }

  const ownerVaults = me ? ledger.vaults.filter((v) => v.owner === me) : [];
  const agentSigner = agentKey ? { kind: "key" as const, address: agentAddr! } : me ? { kind: "wallet" as const, address: me } : null;
  const agentVaults = agentSigner ? ledger.vaults.filter((v) => v.agent === agentSigner.address) : [];
  const agentVault = agentVaults.find((v) => v.vaultId === selected) ?? agentVaults[0] ?? null;
  const nums = headlineNumbers();

  const walletLabel = wallet ? <><span className="addr">{short(wallet.address)}</span> · {walletBalance === null ? "…" : `${formatGen(walletBalance)} GEN`}</> : connecting ? "Approve in wallet…" : "Connect wallet";
  const popFor = (where: Where) => (
    <WalletPop
      pop={pop?.where === where ? pop : null}
      faucet={faucet?.where === where ? faucet : null}
      error={walletError}
      wallets={wallets}
      wallet={wallet}
      connecting={connecting}
      onConnect={connect}
      onDisconnect={() => {
        setWallet(null);
        setWalletBalance(null);
        setPop(null);
      }}
      onClose={() => {
        setPop(null);
        setFaucet(null);
        setWalletError(null);
      }}
      onTryIt={() => {
        setPop(null);
        setTab("try");
        document.getElementById("gate")?.scrollIntoView({ behavior: "smooth" });
      }}
    />
  );

  return (
    <div className="tg" ref={rootRef}>
      <canvas id="scene" aria-hidden="true" />

      <header>
        <a className="brand" href="#top" aria-label="TrustGate V1.3" data-dust="">
          <span><b><span id="bname">TRUSTGATE</span> <em id="bpct">V1.3</em></b><small>Commitment vault · GenLayer Studio Next</small></span>
        </a>
        <nav>
          <a className="btn hide-s" href="/v1" data-dust="">Version 1</a>
          <button className="btn hide-s" type="button" data-dust="" onClick={() => getTestGen("header")} disabled={faucet?.busy}>{faucet?.busy ? "Sending…" : "Get test GEN"}</button>
          <button className="btn hot" type="button" data-dust="" onClick={() => openConnect("header")} aria-expanded={pop?.where === "header"}>{walletLabel}</button>
        </nav>
      </header>
      <div className="tg-pop-wrap">{popFor("header")}</div>

      <button className="snd" id="snd" type="button" aria-pressed="true"><span className="eq"><i /><i /><i /><i /></span><b>Sound on</b></button>
      <div className="meter" aria-hidden="true">Distance to gate<strong id="dist">16 m</strong><div className="bar"><i id="bar" /></div></div>

      <main id="top">
        <section className="hero">
          <div className="mouse" aria-hidden="true" data-dust="24"><i /></div>
          <div className="inner">
            <div className="tag">TrustGate V1.3</div>
            <h1>Before an Agent <span>Says Yes</span></h1>
            <p>V1 told your agent whether it <em>should</em> say yes · V1.3 makes sure it <em>can&apos;t</em> say yes without passing through the gate</p>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>How it works</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Vault" v="your funds on GenLayer" type />
            <Row d={3} k="Mandate" v="plain words" />
            <div className="rule" data-i="" style={{ "--d": 4 } as React.CSSProperties} />
            <Row d={5} k="Seller" v="signs the exact offer" />
            <Row d={6} k="Agent" v="can only request" c="p" type />
            <Row d={7} k="Hard cap" v="checked instantly" />
            <Row d={8} k="Judge" v="GenLayer validators" />
            <div className="rule" data-i="" style={{ "--d": 9 } as React.CSSProperties} />
            <div className="verdicts" data-i="" style={{ "--d": 10 } as React.CSSProperties}><span className="v a">Accept · seller credited</span><span className="v r">Renegotiate · safer terms</span><span className="v x">Reject · money stays locked</span></div>
          </div>
        </section>

        <section className="right">
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Unsafe payments</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <div className="big" data-i="" style={{ "--d": 2 } as React.CSSProperties}><div className="a"><strong>{nums.rulesUnsafe}</strong><small>Normal contract</small></div><div className="b"><strong>{nums.tgUnsafe}</strong><small>TrustGate</small></div></div>
            <div className="rule" data-i="" style={{ "--d": 3 } as React.CSSProperties} />
            <Row d={4} k="Test set" v={`${nums.scored} held-out`} />
            <Row d={5} k="Grey cases" v={`${nums.greyRules} → ${nums.greyTg}`} />
            <Row d={6} k="Injections" v={`${nums.injRules} → ${nums.injTg}`} />
            <Row d={7} k="Safe blocked" v={String(nums.tgFalse)} />
            <div className="note" data-i="" data-type="" style={{ "--d": 8 } as React.CSSProperties}>Written before any fix · never used for tuning</div>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Why GenLayer</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Normal contract" v="can't read the deal" c="g" />
            <Row d={3} k="AI on a server" v="someone controls it" c="g" />
            <div className="rule" data-i="" style={{ "--d": 4 } as React.CSSProperties} />
            <Row d={5} k="GenLayer" v="holds money" />
            <Row d={6} k="" v="reads the deal" />
            <Row d={7} k="" v="nobody controls it" c="p" type />
            <div className="note" data-i="" style={{ "--d": 8 } as React.CSSProperties}>TrustGate has no AI of its own · the judge is GenLayer</div>
          </div>
        </section>

        <section className="right">
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Two agents · one verdict</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Buyer agent" v="requests by offer id" />
            <Row d={3} k="Seller" v="signs every version" />
            <Row d={4} k="Renegotiate" v="terms go to seller" />
            <div className="rule" data-i="" style={{ "--d": 5 } as React.CSSProperties} />
            <Row d={6} k="Money moves" v="signed + accepted only" c="p" type />
            <div className="note" data-i="" style={{ "--d": 7 } as React.CSSProperties}>Neither side can change the terms alone</div>
          </div>
        </section>

        <section>
          <div className="hud" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Limits</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <Row d={2} k="Verdict time" v="a few minutes" />
            <Row d={3} k="Wrong accept" v="bounded by cap" />
            <Row d={4} k="Payout" v="inside the vault" />
            <Row d={5} k="Signature" v="wallet not identity" type />
            <Row d={6} k="Network" v="Studio Next · test GEN" />
          </div>
        </section>

        <section id="gate">
          <div className="hud console" data-panel="">
            <Corners />
            <h2 data-i="" data-type="" style={{ "--d": 0 } as React.CSSProperties}>Send a deal through it</h2>
            <div className="rule" data-i="" style={{ "--d": 1 } as React.CSSProperties} />
            <div className="tabs" role="tablist" aria-label="Console" data-i="" style={{ "--d": 2 } as React.CSSProperties}>
              {([["try", "Try it · no wallet"], ["wallet", "Your wallet"], ["mcp", "AI agent · MCP"], ["feed", "Live feed"], ["bench", "Benchmark"]] as const).map(([id, label]) => (
                <button key={id} className="tab" role="tab" id={`tab-${id}`} aria-controls={`p-${id}`} aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>

            <div className="panes" data-i="" style={{ "--d": 3 } as React.CSSProperties}>
              {/* TRY IT */}
              <div className="pane" role="tabpanel" id="p-try" aria-labelledby="tab-try" hidden={tab !== "try"}>
                <TryIt onOpenNegotiation={showNegotiation} />
              </div>

              {/* YOUR WALLET */}
              <div className="pane" role="tabpanel" id="p-wallet" aria-labelledby="tab-wallet" hidden={tab !== "wallet"}>
                <div className="walletbar">
                  <span className="wstat">{wallet ? <>Connected <a href={EXPLORER_ADDRESS + wallet.address} target="_blank" rel="noreferrer"><code>{short(wallet.address)}</code></a> · {walletBalance === null ? "…" : `${formatGen(walletBalance)} GEN`} · Studio Next 61997</> : "No wallet connected · MetaMask or Rabby · the Studio Next network (chain 61997) is added automatically"}</span>
                  <span className="three">
                    <button className="btn" type="button" onClick={() => getTestGen("pane")} disabled={faucet?.busy}>{faucet?.busy ? "Sending…" : "Get test GEN"}</button>
                    <button className="btn hot" type="button" onClick={() => openConnect("pane")} aria-expanded={pop?.where === "pane"}>{wallet ? "Wallet" : walletLabel}</button>
                  </span>
                </div>
                {popFor("pane")}
                {walletError && !(pop?.where === "pane") && <p className="warn err" role="alert">{walletError}</p>}
                <div className="roles3">
                  <div><b className="rt">Owner</b><span>Deposits GEN into a vault · writes the mandate and hard limits · picks which agent may ask for payments · can top up and take funds back</span></div>
                  <div><b className="rt">Agent · buyer</b><span>The AI or person that wants to spend · can only request payment for a seller&apos;s signed offer · GenLayer validators decide · the vault refuses owner = agent, so to try both roles create an agent key in this browser</span></div>
                  <div><b className="rt">Seller</b><span>Anyone with a wallet · posts a signed offer to a vault and is its payee · sees counterproposals · accepts · counters or declines · use a different account from the owner and the agent</span></div>
                </div>
                <div className="tabs sub" role="tablist" aria-label="Role">
                  {([["owner", "Owner"], ["agent", "Agent · buyer"], ["seller", "Seller"]] as const).map(([id, label]) => (
                    <button key={id} className="tab" role="tab" aria-selected={role === id} onClick={() => setRole(id)}>{label}</button>
                  ))}
                </div>
                <div ref={txRef}>{(pending || live) && <TxPanel pending={pending} live={live} now={now} onConfirm={confirm} onCancel={() => setPending(null)} />}</div>

                {role === "seller" ? (
                  readOnly ? (
                    <p className="note2">This is an older contract without negotiation · switch the Live feed tab to the current site contract to act as a seller</p>
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
                  <div className="cols">
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
                    <div className="stack">
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
                  <div className="cols">
                    <div className="stack">
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
                )}
              </div>

              {/* MCP */}
              <div className="pane" role="tabpanel" id="p-mcp" aria-labelledby="tab-mcp" hidden={tab !== "mcp"}>
                <p className="lead">The TrustGate MCP server lets any MCP client · desktop AI apps · agent frameworks · act as either side · it never waits for minutes · slow steps return at once as pending and the agent polls</p>
                <div className="two">
                  <div className="box"><h3>Buyer tools</h3><div className="row"><b>list offers</b></div><div className="row"><b>request commitment</b><span className="g">by offer id</span></div><div className="row"><b>get verdict</b></div><div className="row"><b>vault status</b></div></div>
                  <div className="box"><h3>Seller tools</h3><div className="row"><b>post offer</b></div><div className="row"><b>get counterproposal</b></div><div className="row"><b>accept counterproposal</b></div><div className="row"><b>counter offer</b></div><div className="row"><b>decline</b></div><div className="row"><b>get negotiation</b></div></div>
                </div>
                <ol className="steps2">
                  <li>In the Owner tab create an agent key and a vault · then use Back up or remove this key to copy the agent key · it is a test key · never use a key that holds real funds</li>
                  <li>Get the code from <a href={REPO} target="_blank" rel="noreferrer">github.com/shoupeorg/TrustGate-V1.3</a> · then run <code>cd mcp &amp;&amp; npm install &amp;&amp; npm run build</code></li>
                  <li>Open the config file of your MCP client · in desktop AI apps it is usually under Settings → Developer → Edit Config · add this and restart the client</li>
                </ol>
                <pre>{`{
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
                <p className="note2">Then ask your agent · for example: List the open offers on vault my-vault-id and request the dataset one · or · Post this offer to vault my-vault-id for 0.5 GEN · set only the key for the side you play · keys stay in that config file on your machine · the server never prints or logs them</p>
              </div>

              {/* LIVE FEED */}
              <div className="pane" role="tabpanel" id="p-feed" aria-labelledby="tab-feed" hidden={tab !== "feed"}>
                <div className="feedhead"><FeedStatus feed={feed} count={ledger.vaults.length} />{feed.error ? <span className="bad">History did not load · retrying</span> : <span className="ok">{feed.loading && !feed.fetchedAt ? "Loading…" : "Live · refreshes every 8 s"}</span>}</div>
                <div className="tabs sub wrap" role="tablist" aria-label="Contract">
                  {VAULT_CONTRACTS.map((c) => (
                    <button key={c.address} className="tab" role="tab" aria-selected={contract === c.address} onClick={() => { setContract(c.address); setSelected(null); }} title={c.note}>
                      {hudText(c.label)}
                    </button>
                  ))}
                </div>
                <p className="note2">Contract <a href={EXPLORER_ADDRESS + contract} target="_blank" rel="noreferrer"><code>{contract}</code></a> · {hudText(VAULT_CONTRACTS.find((c) => c.address === contract)?.note ?? "")}</p>
                {feed.error && (
                  <p className="warn err" role="status">
                    Studio Next history did not load ({feed.error}) · {feed.stale ? "showing the last good snapshot · " : ""}retrying every 8 seconds · <button className="link" type="button" onClick={() => void feed.refresh()}>Retry now</button>
                  </p>
                )}
                {ledger.vaults.length > 1 && (
                  <div className="tabs sub wrap" role="tablist" aria-label="Vault">
                    {ledger.vaults.map((v) => (
                      <button key={v.vaultId} className="tab" role="tab" aria-selected={v.vaultId === current?.vaultId} onClick={() => setSelected(v.vaultId)}>{v.vaultId}</button>
                    ))}
                  </div>
                )}
                {current ? (
                  <VaultView vault={current} book={book} onOpen={showNegotiation} />
                ) : feed.loading ? (
                  <p className="note2">Loading the contract history from Studio Next…</p>
                ) : !feed.error ? (
                  <p className="note2">No vaults on this contract yet · connect a wallet and create one</p>
                ) : null}
              </div>

              {/* BENCHMARK */}
              <div className="pane" role="tabpanel" id="p-bench" aria-labelledby="tab-bench" hidden={tab !== "bench"}>
                <BenchmarkPane />
              </div>
            </div>
            <p className="note2 foot"><a href="/v1">Version 1 · the deal inspector</a> · <a href={REPO} target="_blank" rel="noreferrer">Source code</a> · <a href={REPO + "/blob/main/experiments/PAYOUT_INVESTIGATION.md"} target="_blank" rel="noreferrer">Payout investigation</a> · contract reads failed on Studio Next during development, so this page rebuilds vault state from the transaction history</p>
          </div>
        </section>
      </main>

      {openNeg && (
        <div className="negwrap" onClick={(e) => { if (e.target === e.currentTarget) closeNegotiation(); }}>
          <div className="hud on negmodal" id="negotiation" role="dialog" aria-modal="true" aria-labelledby="neg-title">
            <Corners />
            <h2 id="neg-title">One negotiation · both sides · one verdict</h2>
            <div className="rule" />
            {negotiation ? (
              <NegotiationView n={negotiation} contract={contract !== VAULT_CONTRACTS[0].address ? contract : undefined} onClose={closeNegotiation} />
            ) : (
              <p className="note2">{feed.loading ? "Loading the contract history…" : <>Negotiation <code>{openNeg}</code> is not on this contract yet · a new offer can take a minute to appear · <button className="link" type="button" onClick={closeNegotiation}>Close</button></>}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ d, k, v, c, type }: { d: number; k: string; v: string; c?: "p" | "g" | "y"; type?: boolean }) {
  return (
    <div className="row" data-i="" style={{ "--d": d } as React.CSSProperties}>
      <b>{k}</b>
      <span className={c} data-type={type ? "" : undefined}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------- wallet

function WalletPop({ pop, faucet, error, wallets, wallet, connecting, onConnect, onDisconnect, onClose, onTryIt }: {
  pop: Pop; faucet: FaucetState | null; error: string | null; wallets: DiscoveredWallet[] | null; wallet: ConnectedWallet | null; connecting: string | null;
  onConnect: (w: DiscoveredWallet) => void; onDisconnect: () => void; onClose: () => void; onTryIt: () => void;
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
  const showError = Boolean(error && pop);
  if (!pop && !faucet?.msg) return null;
  return (
    <div className="tg-pop" role="status">
      {pop?.kind === "looking" && <p className="note2">Looking for browser wallets…</p>}
      {pop?.kind === "nowallet" && (
        <p className="note2"><b>No browser wallet found</b> · install <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noreferrer">Rabby</a> · reload this page · then click Connect wallet · the GenLayer Studio Next network (chain 61997) is added automatically · no wallet? <button className="link" type="button" onClick={onTryIt}>Use Try it</button></p>
      )}
      {pop?.kind === "picker" && !wallet && wallets && (
        <div className="three">
          {wallets.slice(0, 3).map((w) => (
            <button key={w.id} className="btn" type="button" onClick={() => onConnect(w)} disabled={Boolean(connecting)}>
              {connecting === w.name ? "Approve in wallet…" : `Connect ${w.name}`}<small>Studio Next · 61997</small>
            </button>
          ))}
        </div>
      )}
      {pop?.kind === "picker" && connecting && slow && <p className="note2">No popup? Click the {connecting} icon in your browser toolbar · it may be waiting for you to unlock it or approve the network</p>}
      {pop?.kind === "account" && wallet && (
        <div className="three">
          <a className="btn" href={EXPLORER_ADDRESS + wallet.address} target="_blank" rel="noreferrer">{short(wallet.address)} ↗</a>
          <button className="btn" type="button" onClick={onDisconnect}>Disconnect</button>
        </div>
      )}
      {showError && <p className="warn err" role="alert">{error}</p>}
      {faucet?.msg && (
        <p className={faucet.error ? "warn err" : "note2 ok"}>
          {faucet.msg} {faucet.hash && <a href={EXPLORER_TX + faucet.hash} target="_blank" rel="noreferrer">tx ↗</a>}
        </p>
      )}
      <button className="link close" type="button" onClick={onClose} aria-label="Close">Close</button>
    </div>
  );
}

// ---------------------------------------------------------------- transactions

const PHASE_TEXT: Record<Progress["phase"], string> = {
  signing: "Waiting for your signature…",
  submitted: "Submitted · waiting for the network to pick it up…",
  pending: "Queued on Studio Next…",
  processing: "GenLayer validators are executing / judging it…",
  decided: "Consensus reached (provisional) · waiting for finalization…",
  finalized: "Finalized",
  failed: "No verdict",
};

function TxPanel({ pending, live, now, onConfirm, onCancel }: { pending: Pending | null; live: Live | null; now: number; onConfirm: () => void; onCancel: () => void }) {
  if (pending) {
    const p = pending.prepared;
    return (
      <div className="txbox pending v13-tx" aria-live="polite">
        <p>
          <b>{pending.label}</b> · network fee up to <b>{formatGen(p.fee)} GEN</b> (unused fee is refunded)
          {p.value > ZERO ? <> + deposit <b>{formatGen(p.value)} GEN</b></> : null} ·{" "}
          {p.via === "agentKey" ? "signed by your browser agent key (no wallet popup)" : "your wallet will ask you to confirm"}
        </p>
        <span className="three"><button className="btn hot" type="button" onClick={onConfirm}>{p.via === "agentKey" ? "Confirm and send" : "Confirm in wallet"}</button><button className="btn" type="button" onClick={onCancel}>Cancel</button></span>
      </div>
    );
  }
  if (!live) return null;
  const secs = Math.max(0, Math.floor((now - live.started) / 1000));
  return (
    <div className={`txbox v13-tx ${live.error ? "error" : "submitted"}`} aria-live="polite">
      <p><b>{live.label}</b>: {live.error ?? PHASE_TEXT[live.progress?.phase ?? "signing"]} {!live.error && live.progress?.phase !== "finalized" && <span className="count">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} elapsed</span>}</p>
      {live.progress?.hash && <a href={EXPLORER_TX + live.progress.hash} target="_blank" rel="noreferrer"><code>{live.progress.hash}</code> ↗</a>}
    </div>
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
    !wallet && "Connect a wallet first",
    agentMode === "key" && !agentKey && "Create the agent key above, or switch to an external agent address",
    agentMode === "external" && !isAddress(external) && "Agent must be a wallet address (0x + 40 hex characters)",
    wallet && agent && agent.toLowerCase() === wallet.address.toLowerCase() && "The agent must be a different address from your wallet (the vault refuses owner = agent)",
    mandate.trim() === "" && "Write a mandate",
    mandate.length > MAX_MANDATE && `Mandate is ${mandate.length - MAX_MANDATE} characters too long`,
    (capWei === null || capWei <= ZERO) && "Hard cap must be a positive GEN amount (up to 18 decimals)",
    totalWei === null && "Total spend cap must be a GEN amount or empty",
    totalWei !== null && totalWei > ZERO && capWei !== null && totalWei < capWei && "Total spend cap is lower than the per-commitment cap",
    allow.invalid.length > 0 && `Not an address: ${allow.invalid[0]}`,
    allow.addresses.length > MAX_ALLOWLIST && `At most ${MAX_ALLOWLIST} allowlisted payees`,
    agent && allow.addresses.includes(agent.toLowerCase()) && "The agent cannot be on the payee allowlist",
    (depositWei === null || depositWei < MIN_DEPOSIT) && `Deposit must be at least ${formatGen(MIN_DEPOSIT)} GEN`,
    depositWei !== null && depositWei > MAX_DEPOSIT && `Deposit is limited to ${formatGen(MAX_DEPOSIT)} GEN on this test site`,
    depositWei !== null && balance !== null && depositWei >= balance && `Your wallet has ${formatGen(balance)} GEN · keep some for fees · use Get test GEN`,
  ].filter(Boolean) as string[];

  function pickTemplate(i: number) {
    if (isTemplate || mandate.trim() === "") return setMandate(MANDATE_TEMPLATES[i].text);
    setTemplateAsk(i);
  }

  return (
    <form className="box" onSubmit={(e) => { e.preventDefault(); if (!errors.length && capWei && depositWei && totalWei !== null) onSubmit(newId("vault"), agent, mandate.trim(), capWei, totalWei, allow.addresses, depositWei); }}>
      <h3>Create a vault</h3>

      <fieldset>
        <legend>Who may request payments · the agent</legend>
        <label className="opt"><input type="radio" name="tg-agent-mode" checked={agentMode === "key"} onChange={() => setAgentMode("key")} /><span>An agent key generated in this browser · to try the Agent role yourself</span></label>
        <label className="opt"><input type="radio" name="tg-agent-mode" checked={agentMode === "external"} onChange={() => setAgentMode("external")} /><span>Another agent&apos;s address</span></label>
      </fieldset>
      {agentMode === "key" ? (
        agentKey ? (
          <>
            <p className="note2">Agent key <a href={EXPLORER_ADDRESS + agentKey.address} target="_blank" rel="noreferrer"><code>{agentKey.address}</code></a> · {agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`}</p>
            {(agentBalance ?? ZERO) < GEN / BigInt(5) && (
              <button type="button" className="btn warnb" disabled={!wallet || disabled} onClick={() => onFundAgent(AGENT_FUNDING)}>
                Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees
              </button>
            )}
            <details className="more">
              <summary>Back up or remove this key</summary>
              <p className="warn">Test only · the key is stored unencrypted in this browser&apos;s local storage · anyone with access to this browser profile can use it · never put real funds on it</p>
              {showKey ? <code className="secret">{agentKey.privateKey}</code> : <button type="button" className="link" onClick={() => setShowKey(true)}>Show private key for backup</button>}
              <button type="button" className="link" onClick={() => { forgetAgentKey(); onAgentKey(null); setShowKey(false); }}>Remove key from this browser</button>
            </details>
          </>
        ) : (
          <>
            <p className="warn">This creates a test-only wallet whose key stays in this browser · local storage · unencrypted · back it up if you want to keep it · never use it for real funds</p>
            <button type="button" className="btn warnb" onClick={() => { try { onAgentKey(createAgentKey()); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Create agent key</button>
            <details className="more">
              <summary>Restore a backed-up agent key</summary>
              <input aria-label="Agent private key" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="0x… (64 hex characters)" spellCheck={false} autoComplete="off" />
              <button type="button" className="link" onClick={() => { try { onAgentKey(importAgentKey(importText)); setImportText(""); setKeyError(null); } catch (e) { setKeyError(errorText(e)); } }}>Restore</button>
            </details>
            {keyError && <p className="warn err">{keyError}</p>}
          </>
        )
      ) : (
        <div className="fieldcol"><label htmlFor="tg-ext-agent">Agent wallet address</label><input id="tg-ext-agent" value={external} onChange={(e) => setExternal(e.target.value)} placeholder="0x…" spellCheck={false} /></div>
      )}

      <div className="field"><label htmlFor="tg-mandate">Mandate · judged by GenLayer validators</label><Counter value={mandate.length} max={MAX_MANDATE} /></div>
      <textarea id="tg-mandate" rows={3} value={mandate} onChange={(e) => setMandate(e.target.value)} />
      <div className="chips" role="group" aria-label="Mandate templates">{MANDATE_TEMPLATES.map((t, i) => <button type="button" className="chip" key={t.name} aria-pressed={mandate === t.text} onClick={() => pickTemplate(i)}>{t.name}</button>)}</div>
      {templateAsk !== null && (
        <p className="note2" role="alert">
          Replace your mandate text with the {MANDATE_TEMPLATES[templateAsk].name} template?{" "}
          <button type="button" className="link" onClick={() => { setMandate(MANDATE_TEMPLATES[templateAsk].text); setTemplateAsk(null); }}>Replace</button>{" · "}
          <button type="button" className="link" onClick={() => setTemplateAsk(null)}>Keep mine</button>
        </p>
      )}

      <div className="two">
        <div><label htmlFor="tg-cap">Hard cap per commitment · enforced · GEN</label><input id="tg-cap" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" /></div>
        <div><label htmlFor="tg-dep">Deposit · GEN{balance !== null && <> · wallet {formatGen(balance)}</>}</label><input id="tg-dep" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" /></div>
      </div>
      {capMismatch && <p className="warn">Your mandate mentions {capMismatch} GEN, but the enforced hard cap is {cap} GEN · only the hard cap is checked deterministically · the text is judged by validators</p>}
      <details className="more">
        <summary>Optional enforced limits · total cap · payee allowlist</summary>
        <label htmlFor="tg-total">Total spend cap for the vault · GEN · empty = none</label>
        <input id="tg-total" value={totalCap} onChange={(e) => setTotalCap(e.target.value)} inputMode="decimal" placeholder="e.g. 10" />
        <label htmlFor="tg-allow">Payee allowlist · addresses separated by commas or new lines · empty = any payee</label>
        <textarea id="tg-allow" rows={2} value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} spellCheck={false} />
      </details>
      <p className="note2">Enforced instantly by the contract: hard cap {capWei ? formatGen(capWei) : "?"} GEN per commitment · {totalWei && totalWei > ZERO ? `${formatGen(totalWei)} GEN in total` : "no total cap"} · {allow.addresses.length ? `${allow.addresses.length} allowlisted payee(s)` : "any payee"} · everything else in the mandate is judged by validators</p>
      {errors.length > 0 && <p className="warn err" role="status">{errors[0]}</p>}
      <button className="btn hot" disabled={disabled || errors.length > 0}>Review fee and create vault</button>
    </form>
  );
}

function OwnerVaults({ vaults, wallet, disabled, onTopUp, onReclaim }: { vaults: Vault[]; wallet: ConnectedWallet | null; disabled: boolean; onTopUp: (v: Vault, amount: bigint) => void; onReclaim: (v: Vault, amount: bigint) => void }) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  return (
    <div className="box">
      <h3>Your vaults</h3>
      {!wallet && <p className="note2">Connect a wallet to see the vaults you own</p>}
      {wallet && vaults.length === 0 && <p className="note2">You have no vaults on this contract yet</p>}
      {vaults.map((v) => {
        const amount = parseGen(amounts[v.vaultId] ?? "1");
        return (
          <div key={v.vaultId} className="ownervault">
            <p className="note2"><b>{v.vaultId}</b> · holds {formatGen(v.funds)} GEN · credited to payees {formatGen(v.released)} GEN · agent {short(v.agent)}</p>
            <div className="inline">
              <input aria-label={`Amount for ${v.vaultId}`} value={amounts[v.vaultId] ?? "1"} onChange={(e) => setAmounts({ ...amounts, [v.vaultId]: e.target.value })} inputMode="decimal" />
              <button type="button" className="btn" disabled={disabled || !amount || amount <= ZERO} onClick={() => amount && onTopUp(v, amount)}>Top up</button>
              <button type="button" className="btn" disabled={disabled || !amount || amount <= ZERO || amount > v.funds} onClick={() => amount && onReclaim(v, amount)}>Take back</button>
            </div>
          </div>
        );
      })}
      <p className="note2">Take back moves GEN from the vault to your credit inside the contract · withdraw it below</p>
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
    <div className="box">
      <h3>Credit inside TrustGate</h3>
      <p className="warn">ACCEPT credits the payee inside the vault contract · withdrawing to a wallet sends a GenLayer transfer that on Studio Next (61997) has not arrived in our tests · the button works · the GEN may not show up in the wallet · <a href={REPO + "/blob/main/experiments/PAYOUT_INVESTIGATION.md"} target="_blank" rel="noreferrer">payout investigation</a></p>
      {rows.map((r) => {
        const credit = ledger.credits.get(r.address) ?? ZERO;
        return (
          <div key={r.who + r.address} className="credit">
            <div className="row"><b>{r.label} <code>{short(r.address)}</code></b><span>{formatGen(credit)} GEN</span></div>
            {r.who !== "lookup" && credit > ZERO && <button type="button" className="btn" disabled={disabled} onClick={() => onWithdraw(r.who as "wallet" | "key", credit)}>Withdraw all</button>}
          </div>
        );
      })}
      <label htmlFor="tg-payee">Check any payee address</label>
      <input id="tg-payee" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="0x…" spellCheck={false} />
      {ledger.withdrawals.length > 0 && <p className="note2">{ledger.withdrawals.length} withdraw call{ledger.withdrawals.length === 1 ? "" : "s"} on this contract so far</p>}
    </div>
  );
}

// ---------------------------------------------------------------- agent

function AgentPanel({ agentKey, agentBalance, wallet, vaults, vault, onSelect }: { agentKey: AgentKey | null; agentBalance: bigint | null; wallet: ConnectedWallet | null; vaults: Vault[]; vault: Vault | null; onSelect: (id: string) => void }) {
  const signer = agentKey ? `your browser agent key ${short(agentKey.address)} (${agentBalance === null ? "…" : `${formatGen(agentBalance)} GEN`})` : wallet ? `your connected wallet ${short(wallet.address)}` : null;
  return (
    <div className="box">
      <h3>Act as the agent</h3>
      {!signer ? (
        <p className="note2">Create an agent key in the Owner tab, or connect the agent&apos;s wallet, to submit requests</p>
      ) : (
        <>
          <p className="note2">Signing as {signer}</p>
          {agentKey && (agentBalance ?? ZERO) === ZERO && <p className="warn">The agent key has no GEN for fees · in the Owner tab click Send {formatGen(AGENT_FUNDING)} GEN from your wallet for its fees</p>}
          {vaults.length === 0 ? (
            <p className="note2">No vault on this contract lists this address as its agent yet · create one in the Owner tab</p>
          ) : (
            <>
              <label htmlFor="tg-agent-vault">Vault</label>
              <select id="tg-agent-vault" value={vault?.vaultId} onChange={(e) => onSelect(e.target.value)}>{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.vaultId} · {formatGen(v.funds)} GEN</option>)}</select>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return <span className={`count${value > max ? " over" : ""}`} aria-live="polite">{value.toLocaleString("en-US")} / {max.toLocaleString("en-US")}</span>;
}

// ---------------------------------------------------------------- feed views

function FeedStatus({ feed, count }: { feed: FeedState; count: number }) {
  const time = feed.fetchedAt ? new Date(feed.fetchedAt).toLocaleTimeString() : null;
  return (
    <span>
      {feed.loading && !time ? "loading…" : `${count} vault${count === 1 ? "" : "s"}`}
      {time && ` · updated ${time}${feed.stale ? " (stale)" : ""}`}
      {feed.source && ` · source: ${feed.source}`}
    </span>
  );
}

function VaultView({ vault, book, onOpen }: { vault: Vault; book: NegotiationBook; onOpen: (id: string) => void }) {
  return (
    <div className="vaultview">
      <div className="stats">
        <div><small>Vault</small><b>{vault.vaultId}</b></div>
        <div><small>Holds</small><b>{formatGen(vault.funds)} GEN</b></div>
        <div><small>Credited to payees</small><b>{formatGen(vault.released)} GEN</b></div>
        <div><small>Hard cap · enforced</small><b>{formatGen(vault.cap)} GEN</b></div>
        {vault.totalCap > ZERO && <div><small>Total cap · enforced</small><b>{formatGen(vault.totalCap)} GEN</b></div>}
      </div>
      <div className="mandate"><small>Mandate · judged by validators</small><MandateLines text={vault.mandate} /></div>
      <p className="note2">
        Owner <a href={EXPLORER_ADDRESS + vault.owner} target="_blank" rel="noreferrer">{short(vault.owner)}</a> · Agent <a href={EXPLORER_ADDRESS + vault.agent} target="_blank" rel="noreferrer">{short(vault.agent)}</a>
        {vault.allowlist.length > 0 && <> · Payee allowlist: {vault.allowlist.map(short).join(", ")}</>}
        {" · "}credits are held inside the vault · wallet payouts don&apos;t arrive on Studio Next yet
      </p>
      <NegotiationList book={book} vaultId={vault.vaultId} onOpen={onOpen} />
      {vault.requests.length === 0 && <p className="note2">No requests yet</p>}
      {[...vault.requests].reverse().map((r) => <RequestCard key={r.event.hash} r={r} onOpen={onOpen} />)}
    </div>
  );
}

function RequestCard({ r, onOpen }: { r: VaultRequest; onOpen: (id: string) => void }) {
  const j = r.event.judgment;
  const verdict = r.stage === "GENLAYER" ? j!.decision : r.stage === "DETERMINISTIC" ? "REJECT" : r.stage === "FAILED" ? "FAILED" : r.stage === "UNDETERMINED" ? "NO VERDICT" : "JUDGING";
  const tone = verdict === "ACCEPT" ? "a" : verdict === "RENEGOTIATE" ? "r" : verdict === "JUDGING" ? "p" : "x";
  const finality = isSettled(r.event.status) ? "Final" : isProvisional(r.event.status) ? "Provisional · finalizing" : r.event.status.toLowerCase();
  const votes = Object.entries(r.event.votes).map(([k, n]) => `${n} ${k}`).join(" · ");

  return (
    <article className={`verdict ${tone}`}>
      <div className="vh"><b>{verdict}</b><span>{formatGen(r.amount)} GEN → {short(r.payee)}</span><em>{finality}</em></div>
      {r.parentId && <p className="note2">Revision of <code>{r.parentId}</code></p>}
      {r.negotiationId && <p className="note2">Offer v{r.offerVersion} signed by the seller · <button className="link" type="button" onClick={() => onOpen(r.negotiationId!)}>open negotiation {r.negotiationId}</button></p>}
      <details className="more">
        <summary>Deal text</summary>
        <p className="deal">{r.dealText}</p>
        {r.justification && <p className="note2">Agent says: {r.justification}</p>}
      </details>
      {r.stage === "GENLAYER" && j && (
        <>
          <p><strong>{cap(j.risk)} risk · {j.confidence.toLowerCase()} confidence</strong> · {j.summary}</p>
          {j.mandate_violations.length > 0 && (
            <ul className="violations">
              {j.mandate_violations.map((v, i) => <li key={i}><b>{v.rule}</b><span>{v.evidence}</span><small>{v.explanation}</small></li>)}
            </ul>
          )}
          {j.decision === "RENEGOTIATE" && j.counterproposal.deal_text && (
            <div className="cp">
              <small>TrustGate counterproposal</small>
              {j.counterproposal.deal_text}
              {(j.counterproposal.notes || r.negotiationId) && <span>{j.counterproposal.notes}{j.counterproposal.notes && r.negotiationId ? " · " : ""}{r.negotiationId ? "sent to the seller, who can accept it (signing it as a new version), counter or decline" : ""}</span>}
            </div>
          )}
          <p className="note2">{r.released ? `ACCEPT: ${formatGen(r.amount)} GEN credited to the ${r.negotiationId ? "seller" : "payee"} inside the vault` : "Funds stay locked in the vault"} · <a href={EXPLORER_TX + r.event.hash} target="_blank" rel="noreferrer">view transaction</a>{votes && <> · validators: {votes}</>}</p>
        </>
      )}
      {r.stage === "DETERMINISTIC" && <p><strong>Blocked by the enforced hard limits, before any judgment</strong> · {r.reasons.join("; ") || "a deterministic check failed"}</p>}
      {r.stage === "FAILED" && <p>The transaction failed before a verdict · for example the caller is not the registered agent, or the request id was reused</p>}
      {r.stage === "UNDETERMINED" && <p>Validators did not reach a verdict ({r.event.status}) · no funds moved · submitting again starts a new judgment</p>}
      {r.stage === "PENDING" && <p>GenLayer validators are judging this request against the mandate · this takes a few minutes</p>}
      {r.stage !== "GENLAYER" && <p className="note2"><a href={EXPLORER_TX + r.event.hash} target="_blank" rel="noreferrer">view transaction</a>{votes && <> · validators: {votes}</>}</p>}
    </article>
  );
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
