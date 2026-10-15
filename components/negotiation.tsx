"use client";

import { useState } from "react";
import { diffWords, type Negotiation, type NegotiationBook, type NegEvent, type Offer, type TimelineStep } from "@/lib/negotiation";
import { EXPLORER_ADDRESS, EXPLORER_TX, formatGen, isProvisional, isSettled, isStuck, MAX_DEAL, MAX_JUSTIFICATION, parseGen, ZERO, type Vault } from "@/lib/vault";

export const MAX_OPEN_PER_SELLER = 3; // mirrors contracts/trustgate_vault.py
const MAX_REASON = 500; // mirrors contracts/trustgate_vault.py
function Count({ value, max }: { value: number; max: number }) {
  return <small className={value > max ? "v13-over" : ""}>{value.toLocaleString()} / {max.toLocaleString()}</small>;
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const finality = (e: NegEvent) => (isSettled(e.status) ? "Final" : isProvisional(e.status) ? "Provisional" : isStuck(e.status) ? "No verdict" : (e.execution ?? "").toUpperCase() === "ERROR" ? "Refused" : "Pending");
const STATUS_TEXT: Record<string, string> = {
  OPEN: "open: waiting for the buyer's agent to request it",
  JUDGING: "GenLayer validators are judging it",
  AWAITING_SELLER: "waiting for the seller: accept the counterproposal, counter, or decline",
  BLOCKED: "blocked by the vault's hard limits; the seller can counter",
  REJECTED: "rejected by GenLayer; the seller can counter or decline",
  ACCEPTED: "accepted by GenLayer; funds credited to the seller",
  SUPERSEDED: "replaced by a newer version",
  DECLINED: "declined by the seller",
  WITHDRAWN: "withdrawn by the buyer",
};

export function negotiationLink(id: string, contract?: string) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("negotiation", id);
  if (contract) url.searchParams.set("contract", contract);
  return `${url.toString()}#negotiation`;
}

// ---------------------------------------------------------------- explanation

export function BothSides() {
  return (
    <section className="v13-try" aria-labelledby="both-title">
      <p className="eyebrow">Two agents, one verdict</p>
      <h2 id="both-title">Both sides rely on the same verdict</h2>
      <p className="v13-both"><b>Both agents rely on the same verdict. Neither side can change the terms alone. Money moves only for terms the seller signed and GenLayer accepted.</b></p>
      <ol className="v13-steps">
        <li>The seller posts an offer from its own wallet. The contract stores the exact text and its hash; it can never be edited, only replaced by a new signed version.</li>
        <li>The buyer&apos;s agent requests a commitment by offer id. It cannot change the payee, the amount or the text.</li>
        <li>GenLayer validators judge it against the owner&apos;s mandate. On RENEGOTIATE the counterproposal goes to the <em>seller</em>, who accepts it (signing it word for word), counters, or declines.</li>
        <li>Funds are credited to the seller only after an ACCEPT on a version the seller signed.</li>
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- negotiation view

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <p className="v13-diff">
      {diffWords(before, after).map((p, i) => <span key={i} className={p.type === "added" ? "d-add" : p.type === "removed" ? "d-del" : undefined}>{p.text}</span>)}
    </p>
  );
}

function Step({ s, n, prev }: { s: TimelineStep; n: Negotiation; prev?: Offer }) {
  const tx = (
    <footer>
      <span className="v13-finality">{finality(s.event)}</span>
      <a href={EXPLORER_TX + s.event.hash} target="_blank" rel="noreferrer">tx ↗</a>
    </footer>
  );
  if (s.kind === "offer") {
    const o = s.offer;
    const title = o.origin === "posted" ? `Offer v${o.version} posted` : o.origin === "countered" ? `Seller countered: v${o.version}` : `Seller signed TrustGate's counterproposal: v${o.version}`;
    return (
      <li className="v13-step">
        <header><b>{title}</b><span>{formatGen(o.amount)} GEN → {short(o.seller)}</span></header>
        <p className="v13-note">Signed by the seller <a href={EXPLORER_ADDRESS + o.seller} target="_blank" rel="noreferrer"><code>{short(o.seller)}</code></a> · status: {STATUS_TEXT[o.status] ?? o.status} · text hash <code>{o.termsHash.slice(0, 12)}…</code></p>
        {prev ? (
          <details open>
            <summary>Changes from v{prev.version}{prev.amount !== o.amount ? ` (price ${formatGen(prev.amount)} → ${formatGen(o.amount)} GEN)` : ""}</summary>
            <Diff before={prev.terms} after={o.terms} />
          </details>
        ) : (
          <p className="v13-deal">{o.terms}</p>
        )}
        {tx}
      </li>
    );
  }
  if (s.kind === "request") {
    const r = s.request;
    const j = r.judgment;
    const verdict = r.stage === "GENLAYER" && j ? j.decision : r.stage === "DETERMINISTIC" ? "REJECT (hard limit)" : r.stage === "UNDETERMINED" ? "NO VERDICT" : "JUDGING";
    const tone = verdict === "ACCEPT" ? "low" : verdict === "RENEGOTIATE" ? "medium" : verdict === "JUDGING" ? "pending" : "high";
    const offer = n.offers.find((o) => o.offerId === r.offerId);
    return (
      <li className={`v13-step v13-request tone-${tone}`}>
        <header><span className="v13-verdict">{verdict}</span><span>GenLayer verdict on v{offer?.version ?? "?"}</span></header>
        {r.justification && <p className="v13-note">Buyer&apos;s agent says (untrusted): {r.justification}</p>}
        {j && (
          <>
            <p className="v13-summary"><b>{j.risk} risk.</b> {j.summary}</p>
            {j.mandate_violations.length > 0 && <ul className="v13-violations">{j.mandate_violations.map((v, i) => <li key={i}><b>{v.rule}</b><span>{v.evidence}</span><small>{v.explanation}</small></li>)}</ul>}
            {j.decision === "RENEGOTIATE" && j.counterproposal.deal_text && (
              <div className="v13-counter">
                <small>Counterproposal, sent to the seller</small>
                {offer ? <Diff before={offer.terms} after={j.counterproposal.deal_text} /> : <p>{j.counterproposal.deal_text}</p>}
                {j.counterproposal.notes && <p className="v13-note">{j.counterproposal.notes}</p>}
              </div>
            )}
          </>
        )}
        {r.stage === "DETERMINISTIC" && <p className="v13-summary">Blocked by the vault&apos;s enforced hard limits before any judgment (for example over the cap, the total cap, the allowlist, or the funds).</p>}
        {r.stage === "PENDING" && <p className="v13-summary">Validators are judging this exact text against the mandate. This takes a few minutes.</p>}
        <p className="v13-note">{r.released ? <b>{formatGen(r.amount)} GEN credited to the seller {short(r.payee)} inside the vault.</b> : "No funds moved."}</p>
        {tx}
      </li>
    );
  }
  return (
    <li className="v13-step">
      <header><b>{s.kind === "declined" ? "Seller declined" : "Buyer withdrew"}</b><span>{short(s.by)}</span></header>
      {s.reason && <p className="v13-note">Reason: {s.reason}</p>}
      <p className="v13-note">Negotiation closed. No funds moved.</p>
      {tx}
    </li>
  );
}

export function NegotiationView({ n, contract, onClose }: { n: Negotiation; contract?: string; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  const outcome = n.status === "ACCEPTED" ? "Deal accepted: funds credited to the seller" : n.status === "DECLINED" ? "Seller declined: no deal" : n.status === "WITHDRAWN" ? "Buyer withdrew: no deal" : STATUS_TEXT[n.latest.status] ?? n.latest.status;
  return (
    <div className="v13-negotiation">
      <div className="v13-vault-head">
        <div><small>Negotiation</small><b>{n.negotiationId}</b></div>
        <div><small>Vault</small><b>{n.vaultId}</b></div>
        <div><small>Seller</small><b>{short(n.seller)}</b></div>
        <div><small>Versions</small><b>{n.offers.length}</b></div>
      </div>
      <p className={`v13-outcome tone-${n.status === "ACCEPTED" ? "low" : n.status === "OPEN" ? "medium" : "high"}`}><b>{outcome}</b></p>
      <ol className="v13-timeline">
        {n.timeline.map((s, i) => {
          const prev = s.kind === "offer" && s.offer.previousOfferId ? n.offers.find((o) => o.offerId === s.offer.previousOfferId) : undefined;
          return <Step key={s.event.hash + i} s={s} n={n} prev={prev} />;
        })}
      </ol>
      <p className="v13-actions">
        <button onClick={() => { void navigator.clipboard?.writeText(negotiationLink(n.negotiationId, contract)).then(() => setCopied(true)); }}>{copied ? "Link copied" : "Copy shareable link"}</button>
        {onClose && <button onClick={onClose}>Close</button>}
      </p>
    </div>
  );
}

export function NegotiationList({ book, vaultId, onOpen }: { book: NegotiationBook; vaultId: string; onOpen: (id: string) => void }) {
  const list = [...book.negotiations.values()].filter((n) => n.vaultId === vaultId).reverse();
  if (!list.length) return null;
  return (
    <div className="v13-neglist">
      <small>Negotiations on this vault</small>
      {list.map((n) => (
        <button key={n.negotiationId} onClick={() => onOpen(n.negotiationId)}>
          <b>{n.negotiationId}</b> · v{n.latest.version} · {formatGen(n.latest.amount)} GEN · {n.status === "OPEN" ? n.latest.status : n.status}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- buyer's agent: request by offer

export function OfferRequests({ vault, book, disabled, onRequest, onOpen }: { vault: Vault; book: NegotiationBook; disabled: boolean; onRequest: (o: Offer, justification: string) => void; onOpen: (id: string) => void }) {
  const [just, setJust] = useState<Record<string, string>>({});
  const open = [...book.negotiations.values()].filter((n) => n.vaultId === vault.vaultId && n.status === "OPEN" && n.latest.status === "OPEN").map((n) => n.latest).reverse();
  return (
    <div className="v13-card">
      <p className="eyebrow">Buyer&apos;s agent</p>
      <h3>Request a commitment against a signed offer</h3>
      <p className="v13-note">Sellers post offers to vault <b>{vault.vaultId}</b> (Seller tab). You pick one; the payee, the amount and the text come from the seller&apos;s signed offer and cannot be changed here. Enforced: hard cap {formatGen(vault.cap)} GEN · vault holds {formatGen(vault.funds)} GEN.</p>
      {open.length === 0 && <p className="v13-note">No open offers for this vault yet. Share the vault id with a seller, or post one yourself from another account in the Seller tab.</p>}
      {open.map((o) => (
        <div key={o.offerId} className="v13-offer">
          <p><b>v{o.version}</b> · {formatGen(o.amount)} GEN → <code>{short(o.seller)}</code> {o.amount > vault.cap && <span className="v13-over">(above the hard cap: will be blocked)</span>}</p>
          <p className="v13-deal">{o.terms}</p>
          <label><span className="v13-label-row">Justification (untrusted; judged as a claim) <Count value={(just[o.offerId] ?? "").length} max={MAX_JUSTIFICATION} /></span><textarea rows={2} value={just[o.offerId] ?? ""} onChange={(e) => setJust({ ...just, [o.offerId]: e.target.value })} /></label>
          {(just[o.offerId] ?? "").length > MAX_JUSTIFICATION && <p className="v13-error">The justification is {(just[o.offerId] ?? "").length - MAX_JUSTIFICATION} characters too long. Nothing is cut; shorten it to request.</p>}
          <span className="v13-actions">
            <button disabled={disabled || (just[o.offerId] ?? "").length > MAX_JUSTIFICATION} onClick={() => onRequest(o, just[o.offerId] ?? "")}>Review fee and request</button>
            <button onClick={() => onOpen(o.negotiationId)}>Open negotiation</button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- seller mode

export function SellerMode({ me, vaults, book, disabled, onPost, onAccept, onCounter, onDecline, onOpen }: {
  me: string | null; vaults: Vault[]; book: NegotiationBook; disabled: boolean;
  onPost: (vaultId: string, amount: bigint, terms: string) => void;
  onAccept: (o: Offer) => void;
  onCounter: (o: Offer, amount: bigint, terms: string) => void;
  onDecline: (o: Offer, reason: string) => void;
  onOpen: (id: string) => void;
}) {
  const [vaultId, setVaultId] = useState("");
  const [amount, setAmount] = useState("0.5");
  const [terms, setTerms] = useState("");
  const amountWei = parseGen(amount);
  const target = vaults.find((v) => v.vaultId === vaultId.trim());
  const mine = me ? [...book.negotiations.values()].filter((n) => n.seller === me).reverse() : [];
  const openHere = target ? mine.filter((n) => n.vaultId === target.vaultId && n.status === "OPEN").length : 0;
  const errors = [
    !me && "Connect a wallet (top right) to act as the seller.",
    !target && "Pick a vault (or paste its id).",
    target && me && target.agent === me && "This wallet is the vault's agent; the vault would block paying itself. Use another account.",
    (amountWei === null || amountWei <= ZERO) && "Price must be a positive GEN amount.",
    terms.trim() === "" && "Write the full terms.",
    terms.length > MAX_DEAL && `Terms are ${terms.length - MAX_DEAL} characters too long.`,
    openHere >= MAX_OPEN_PER_SELLER && `You already have ${MAX_OPEN_PER_SELLER} open negotiations with this vault. Close (decline) one first.`,
  ].filter(Boolean) as string[];

  return (
    <div className="v13-grid">
      <form className="v13-card" onSubmit={(e) => { e.preventDefault(); if (!errors.length && amountWei && target) onPost(target.vaultId, amountWei, terms); }}>
        <p className="eyebrow">Seller</p>
        <h3>Post an offer to a vault</h3>
        <p className="v13-note">You sign the offer with your wallet and you are the payee. The exact text and its hash are stored on-chain; to change it later you post a new version. Anyone can be a seller. Your signature proves you control the payee wallet, not who you are. Spam limit, enforced by the contract: at most {MAX_OPEN_PER_SELLER} open negotiations per seller per vault{target ? ` (you have ${openHere} open here)` : ""}.</p>
        <label>Vault<input list="v13-vault-ids" value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="vault id" spellCheck={false} /></label>
        <datalist id="v13-vault-ids">{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.mandate.slice(0, 60)}</option>)}</datalist>
        {target && <p className="v13-mandate"><small>Buyer&apos;s mandate (what GenLayer judges against) · hard cap {formatGen(target.cap)} GEN</small>{target.mandate}</p>}
        <label>Price (GEN)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
        <label><span className="v13-label-row">Full terms <small className={terms.length > MAX_DEAL ? "v13-over" : ""}>{terms.length.toLocaleString()} / {MAX_DEAL.toLocaleString()}</small></span><textarea rows={5} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="What you deliver, price, payment and refund terms." /></label>
        {errors.length > 0 && <p className="v13-error" role="status">{errors[0]}</p>}
        <button className="v13-primary" disabled={disabled || errors.length > 0}>Review fee and post offer</button>
      </form>
      <div className="v13-card">
        <p className="eyebrow">Seller</p>
        <h3>Your negotiations</h3>
        {!me && <p className="v13-note">Connect a wallet to see offers you signed.</p>}
        {me && mine.length === 0 && <p className="v13-note">No offers signed by {short(me)} on this contract yet.</p>}
        {mine.map((n) => <SellerNegotiation key={n.negotiationId} n={n} disabled={disabled} onAccept={onAccept} onCounter={onCounter} onDecline={onDecline} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function SellerNegotiation({ n, disabled, onAccept, onCounter, onDecline, onOpen }: { n: Negotiation; disabled: boolean; onAccept: (o: Offer) => void; onCounter: (o: Offer, amount: bigint, terms: string) => void; onDecline: (o: Offer, reason: string) => void; onOpen: (id: string) => void }) {
  const o = n.latest;
  const [mode, setMode] = useState<"none" | "counter" | "decline">("none");
  const [amount, setAmount] = useState(formatGen(o.amount));
  const [terms, setTerms] = useState(o.counterproposal?.dealText ?? o.terms);
  const [reason, setReason] = useState("");
  const canChange = n.status === "OPEN" && o.status !== "JUDGING";
  const amountWei = parseGen(amount);
  return (
    <div className="v13-offer">
      <p><b>{n.negotiationId}</b> · v{o.version} · {formatGen(o.amount)} GEN · vault {n.vaultId}</p>
      <p className="v13-note">{n.status === "OPEN" ? STATUS_TEXT[o.status] ?? o.status : `closed: ${n.status.toLowerCase()}`}</p>
      {o.status === "AWAITING_SELLER" && o.counterproposal && (
        <div className="v13-counter">
          <small>TrustGate&apos;s counterproposal (changes from your v{o.version})</small>
          <Diff before={o.terms} after={o.counterproposal.dealText} />
          {o.counterproposal.notes && <p className="v13-note">{o.counterproposal.notes}</p>}
          <button disabled={disabled} onClick={() => onAccept(o)}>Accept: sign exactly this text as v{o.version + 1}</button>
        </div>
      )}
      {canChange && (
        <span className="v13-actions">
          <button onClick={() => setMode(mode === "counter" ? "none" : "counter")}>Counter with my own version</button>
          <button onClick={() => setMode(mode === "decline" ? "none" : "decline")}>Decline</button>
          <button onClick={() => onOpen(n.negotiationId)}>Open timeline</button>
        </span>
      )}
      {!canChange && <span className="v13-actions"><button onClick={() => onOpen(n.negotiationId)}>Open timeline</button></span>}
      {canChange && mode === "counter" && (
        <div className="v13-inline-form">
          <label>Price (GEN)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
          <label><span className="v13-label-row">New terms <Count value={terms.length} max={MAX_DEAL} /></span><textarea rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} /></label>
          {terms.length > MAX_DEAL && <p className="v13-error">The terms are {terms.length - MAX_DEAL} characters too long. Nothing is cut; shorten them to sign.</p>}
          <button className="v13-secondary" disabled={disabled || !amountWei || amountWei <= ZERO || terms.trim() === "" || terms.length > MAX_DEAL} onClick={() => amountWei && onCounter(o, amountWei, terms)}>Review fee and sign v{o.version + 1}</button>
        </div>
      )}
      {canChange && mode === "decline" && (
        <div className="v13-inline-form">
          <label><span className="v13-label-row">Reason (optional, public) <Count value={reason.length} max={MAX_REASON} /></span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {reason.length > MAX_REASON && <p className="v13-error">The reason is {reason.length - MAX_REASON} characters too long. Nothing is cut; shorten it to decline.</p>}
          <button className="v13-secondary" disabled={disabled || reason.length > MAX_REASON} onClick={() => onDecline(o, reason)}>Review fee and decline</button>
        </div>
      )}
    </div>
  );
}
