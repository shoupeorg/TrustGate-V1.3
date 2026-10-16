"use client";

import { useState } from "react";
import { diffWords, type Negotiation, type NegotiationBook, type NegEvent, type Offer, type TimelineStep } from "@/lib/negotiation";
import { EXPLORER_ADDRESS, EXPLORER_TX, formatGen, isProvisional, isSettled, isStuck, MAX_DEAL, MAX_JUSTIFICATION, parseGen, ZERO, type Vault } from "@/lib/vault";
import { MandateLines } from "@/components/landing/hud";

export const MAX_OPEN_PER_SELLER = 3; // mirrors contracts/trustgate_vault.py
const MAX_REASON = 500; // mirrors contracts/trustgate_vault.py
function Count({ value, max }: { value: number; max: number }) {
  return <span className={`count${value > max ? " over" : ""}`}>{value.toLocaleString("en-US")} / {max.toLocaleString("en-US")}</span>;
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const finality = (e: NegEvent) => (isSettled(e.status) ? "Final" : isProvisional(e.status) ? "Provisional" : isStuck(e.status) ? "No verdict" : (e.execution ?? "").toUpperCase() === "ERROR" ? "Refused" : "Pending");
const lower = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const STATUS_TEXT: Record<string, string> = {
  OPEN: "open · waiting for the buyer's agent to request it",
  JUDGING: "GenLayer validators are judging it",
  AWAITING_SELLER: "waiting for the seller · accept the counterproposal, counter or decline",
  BLOCKED: "blocked by the vault's hard limits · the seller can counter",
  REJECTED: "rejected by GenLayer · the seller can counter or decline",
  ACCEPTED: "accepted by GenLayer · funds credited to the seller",
  SUPERSEDED: "replaced by a newer version",
  DECLINED: "declined by the seller",
  WITHDRAWN: "withdrawn by the buyer",
};

export function negotiationLink(id: string, contract?: string) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("negotiation", id);
  if (contract) url.searchParams.set("contract", contract);
  return url.toString();
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
      <span>{finality(s.event)}</span>
      <a href={EXPLORER_TX + s.event.hash} target="_blank" rel="noreferrer">tx ↗</a>
    </footer>
  );
  if (s.kind === "offer") {
    const o = s.offer;
    const title = o.origin === "posted" ? `Offer v${o.version} posted` : o.origin === "countered" ? `Seller countered · v${o.version}` : `Seller signed TrustGate's counterproposal · v${o.version}`;
    return (
      <li className="v13-step">
        <div className="row"><b>{title}</b><span className="g">{formatGen(o.amount)} GEN → {short(o.seller)}</span></div>
        <p className="note2">Signed by the seller <a href={EXPLORER_ADDRESS + o.seller} target="_blank" rel="noreferrer"><code>{short(o.seller)}</code></a> · status: {STATUS_TEXT[o.status] ?? o.status} · text hash <code>{o.termsHash.slice(0, 12)}…</code></p>
        {prev ? (
          <details className="more" open>
            <summary>Changes from v{prev.version}{prev.amount !== o.amount ? ` · price ${formatGen(prev.amount)} → ${formatGen(o.amount)} GEN` : ""}</summary>
            <Diff before={prev.terms} after={o.terms} />
          </details>
        ) : (
          <p className="deal">{o.terms}</p>
        )}
        {tx}
      </li>
    );
  }
  if (s.kind === "request") {
    const r = s.request;
    const j = r.judgment;
    const verdict = r.stage === "GENLAYER" && j ? j.decision : r.stage === "DETERMINISTIC" ? "REJECT (hard limit)" : r.stage === "UNDETERMINED" ? "NO VERDICT" : "JUDGING";
    const tone = verdict === "ACCEPT" ? "a" : verdict === "RENEGOTIATE" ? "r" : verdict === "JUDGING" ? "p" : "x";
    const offer = n.offers.find((o) => o.offerId === r.offerId);
    return (
      <li className="v13-step">
        <div className={`verdict ${tone}`}>
          <div className="vh"><b className="v13-verdict">{verdict}</b><span>GenLayer verdict on v{offer?.version ?? "?"}</span></div>
          {r.justification && <p className="note2">Buyer&apos;s agent says (untrusted): {r.justification}</p>}
          {j && (
            <>
              <p><strong>{lower(j.risk)} risk</strong> · {j.summary}</p>
              {j.mandate_violations.length > 0 && <ul className="violations">{j.mandate_violations.map((v, i) => <li key={i}><b>{v.rule}</b><span>{v.evidence}</span><small>{v.explanation}</small></li>)}</ul>}
              {j.decision === "RENEGOTIATE" && j.counterproposal.deal_text && (
                <div className="cp">
                  <small>Counterproposal · sent to the seller</small>
                  {offer ? <Diff before={offer.terms} after={j.counterproposal.deal_text} /> : j.counterproposal.deal_text}
                  {j.counterproposal.notes && <span>{j.counterproposal.notes}</span>}
                </div>
              )}
            </>
          )}
          {r.stage === "DETERMINISTIC" && <p>Blocked by the vault&apos;s enforced hard limits before any judgment · for example over the cap, the total cap, the allowlist or the funds</p>}
          {r.stage === "PENDING" && <p>Validators are judging this exact text against the mandate · this takes a few minutes</p>}
          <p className="note2">{r.released ? <b>{formatGen(r.amount)} GEN credited to the seller {short(r.payee)} inside the vault</b> : "No funds moved"}</p>
        </div>
        {tx}
      </li>
    );
  }
  return (
    <li className="v13-step">
      <div className="row"><b>{s.kind === "declined" ? "Seller declined" : "Buyer withdrew"}</b><span className="g">{short(s.by)}</span></div>
      {s.reason && <p className="note2">Reason: {s.reason}</p>}
      <p className="note2">Negotiation closed · no funds moved</p>
      {tx}
    </li>
  );
}

export function NegotiationView({ n, contract, onClose }: { n: Negotiation; contract?: string; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  const outcome = n.status === "ACCEPTED" ? "Deal accepted · funds credited to the seller" : n.status === "DECLINED" ? "Seller declined · no deal" : n.status === "WITHDRAWN" ? "Buyer withdrew · no deal" : STATUS_TEXT[n.latest.status] ?? n.latest.status;
  return (
    <div className="negview">
      <div className="stats">
        <div><small>Negotiation</small><b>{n.negotiationId}</b></div>
        <div><small>Vault</small><b>{n.vaultId}</b></div>
        <div><small>Seller</small><b>{short(n.seller)}</b></div>
        <div><small>Versions</small><b>{n.offers.length}</b></div>
      </div>
      <p className={`outcome ${n.status === "ACCEPTED" ? "a" : n.status === "OPEN" ? "r" : "x"}`}><b>{outcome}</b></p>
      <ol className="v13-timeline">
        {n.timeline.map((s, i) => {
          const prev = s.kind === "offer" && s.offer.previousOfferId ? n.offers.find((o) => o.offerId === s.offer.previousOfferId) : undefined;
          return <Step key={s.event.hash + i} s={s} n={n} prev={prev} />;
        })}
      </ol>
      <p className="three">
        <button className="btn hot" type="button" onClick={() => { void navigator.clipboard?.writeText(negotiationLink(n.negotiationId, contract)).then(() => setCopied(true)); }}>{copied ? "Link copied" : "Copy shareable link"}</button>
        {onClose && <button className="btn" type="button" onClick={onClose}>Close</button>}
      </p>
    </div>
  );
}

export function NegotiationList({ book, vaultId, onOpen }: { book: NegotiationBook; vaultId: string; onOpen: (id: string) => void }) {
  const list = [...book.negotiations.values()].filter((n) => n.vaultId === vaultId).reverse();
  if (!list.length) return null;
  return (
    <div className="neglist">
      <small>Negotiations on this vault</small>
      {list.map((n) => {
        const st = n.status === "OPEN" ? n.latest.status : n.status;
        return (
          <button key={n.negotiationId} type="button" className="row" onClick={() => onOpen(n.negotiationId)}>
            <b>{n.negotiationId} · v{n.latest.version} · {formatGen(n.latest.amount)} GEN</b>
            <span className={st === "ACCEPTED" ? "" : st === "DECLINED" || st === "REJECTED" || st === "WITHDRAWN" ? "g" : "y"}>{st.toLowerCase().replace(/_/g, " ")}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- buyer's agent: request by offer

export function OfferRequests({ vault, book, disabled, onRequest, onOpen }: { vault: Vault; book: NegotiationBook; disabled: boolean; onRequest: (o: Offer, justification: string) => void; onOpen: (id: string) => void }) {
  const [just, setJust] = useState<Record<string, string>>({});
  const open = [...book.negotiations.values()].filter((n) => n.vaultId === vault.vaultId && n.status === "OPEN" && n.latest.status === "OPEN").map((n) => n.latest).reverse();
  return (
    <div className="box">
      <h3>Request a payment</h3>
      <p className="note2">Sellers post offers to vault <b>{vault.vaultId}</b> (Seller tab) · pick one · the payee, the amount and the text come from the seller&apos;s signed offer and cannot be changed here · enforced: hard cap {formatGen(vault.cap)} GEN · vault holds {formatGen(vault.funds)} GEN</p>
      {open.length === 0 && <p className="note2">No open offers for this vault yet · share the vault id with a seller, or post one yourself from another account in the Seller tab</p>}
      {open.map((o) => {
        const j = just[o.offerId] ?? "";
        return (
          <div key={o.offerId} className="offer">
            <p className="note2"><b>{o.offerId} · v{o.version}</b> · {formatGen(o.amount)} GEN → <code>{short(o.seller)}</code> {o.amount > vault.cap && <span className="over">· above the hard cap · will be blocked</span>}</p>
            <p className="deal">{o.terms}</p>
            <div className="field"><label htmlFor={`j-${o.offerId}`}>Justification · untrusted · shown to the validators</label><Count value={j.length} max={MAX_JUSTIFICATION} /></div>
            <textarea id={`j-${o.offerId}`} rows={2} value={j} placeholder="Why this purchase fits the mandate" onChange={(e) => setJust({ ...just, [o.offerId]: e.target.value })} />
            {j.length > MAX_JUSTIFICATION && <p className="warn err">The justification is {j.length - MAX_JUSTIFICATION} characters too long · nothing is cut · shorten it to request</p>}
            <span className="three">
              <button className="btn hot" type="button" disabled={disabled || j.length > MAX_JUSTIFICATION} onClick={() => onRequest(o, j)}>Review fee and request commitment</button>
              <button className="btn" type="button" onClick={() => onOpen(o.negotiationId)}>Open negotiation</button>
            </span>
          </div>
        );
      })}
      <p className="note2">Hard limits are checked instantly · GenLayer validators then judge the offer · a few minutes</p>
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
    !me && "Connect a wallet to act as the seller",
    !target && "Pick a vault or paste its id",
    target && me && target.agent === me && "This wallet is the vault's agent · the vault would block paying itself · use another account",
    (amountWei === null || amountWei <= ZERO) && "Price must be a positive GEN amount",
    terms.trim() === "" && "Write the full terms",
    terms.length > MAX_DEAL && `Terms are ${terms.length - MAX_DEAL} characters too long`,
    openHere >= MAX_OPEN_PER_SELLER && `You already have ${MAX_OPEN_PER_SELLER} open negotiations with this vault · close (decline) one first`,
  ].filter(Boolean) as string[];

  return (
    <div className="cols">
      <form className="box" onSubmit={(e) => { e.preventDefault(); if (!errors.length && amountWei && target) onPost(target.vaultId, amountWei, terms); }}>
        <h3>Post an offer</h3>
        <label htmlFor="tg-sv">Vault id</label>
        <input id="tg-sv" list="v13-vault-ids" value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="vault-…" spellCheck={false} />
        <datalist id="v13-vault-ids">{vaults.map((v) => <option key={v.vaultId} value={v.vaultId}>{v.mandate.slice(0, 60)}</option>)}</datalist>
        {target && <div className="mandate"><small>Buyer&apos;s mandate · what GenLayer judges against · hard cap {formatGen(target.cap)} GEN</small><MandateLines text={target.mandate} /></div>}
        <div className="field"><label htmlFor="tg-st">Terms · the exact text is stored and hashed</label><Count value={terms.length} max={MAX_DEAL} /></div>
        <textarea id="tg-st" rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="What you deliver · price · payment and refund terms" />
        <label htmlFor="tg-sa">Amount · GEN</label>
        <input id="tg-sa" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.5" />
        <p className="note2">You sign the offer with your wallet and you are always the payee · an offer can never be edited · a change is a new signed version · your signature proves you control the payee wallet, not who you are · at most {MAX_OPEN_PER_SELLER} open negotiations per seller per vault{target ? ` · you have ${openHere} open here` : ""}</p>
        {errors.length > 0 && <p className="warn err" role="status">{errors[0]}</p>}
        <button className="btn hot" disabled={disabled || errors.length > 0}>Review fee and post offer</button>
      </form>
      <div className="box">
        <h3>Counterproposals</h3>
        <p className="note2">When GenLayer answers RENEGOTIATE the safer terms appear here</p>
        {!me && <p className="note2">Connect a wallet to see offers you signed</p>}
        {me && mine.length === 0 && <p className="note2">No offers signed by {short(me)} on this contract yet</p>}
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
    <div className="offer">
      <p className="note2"><b>{n.negotiationId}</b> · v{o.version} · {formatGen(o.amount)} GEN · vault {n.vaultId}</p>
      <p className="note2">{n.status === "OPEN" ? STATUS_TEXT[o.status] ?? o.status : `closed · ${n.status.toLowerCase()}`}</p>
      {o.status === "AWAITING_SELLER" && o.counterproposal && (
        <div className="cp">
          <small>TrustGate&apos;s counterproposal · changes from your v{o.version}</small>
          <Diff before={o.terms} after={o.counterproposal.dealText} />
          {o.counterproposal.notes && <span>{o.counterproposal.notes}</span>}
          <button className="btn warnb" type="button" disabled={disabled} onClick={() => onAccept(o)}>Accept · sign exactly this text as v{o.version + 1}</button>
        </div>
      )}
      <span className="three">
        {canChange && <button className="btn" type="button" aria-pressed={mode === "counter"} onClick={() => setMode(mode === "counter" ? "none" : "counter")}>Counter</button>}
        {canChange && <button className="btn" type="button" aria-pressed={mode === "decline"} onClick={() => setMode(mode === "decline" ? "none" : "decline")}>Decline</button>}
        <button className="btn" type="button" onClick={() => onOpen(n.negotiationId)}>Open timeline</button>
      </span>
      {canChange && mode === "counter" && (
        <div className="inline-form">
          <label htmlFor={`ca-${o.offerId}`}>Price · GEN</label>
          <input id={`ca-${o.offerId}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <div className="field"><label htmlFor={`ct-${o.offerId}`}>New terms</label><Count value={terms.length} max={MAX_DEAL} /></div>
          <textarea id={`ct-${o.offerId}`} rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
          {terms.length > MAX_DEAL && <p className="warn err">The terms are {terms.length - MAX_DEAL} characters too long · nothing is cut · shorten them to sign</p>}
          <button className="btn hot" type="button" disabled={disabled || !amountWei || amountWei <= ZERO || terms.trim() === "" || terms.length > MAX_DEAL} onClick={() => amountWei && onCounter(o, amountWei, terms)}>Review fee and sign v{o.version + 1}</button>
        </div>
      )}
      {canChange && mode === "decline" && (
        <div className="inline-form">
          <div className="field"><label htmlFor={`cr-${o.offerId}`}>Reason · optional · public</label><Count value={reason.length} max={MAX_REASON} /></div>
          <input id={`cr-${o.offerId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          {reason.length > MAX_REASON && <p className="warn err">The reason is {reason.length - MAX_REASON} characters too long · nothing is cut · shorten it to decline</p>}
          <button className="btn hot" type="button" disabled={disabled || reason.length > MAX_REASON} onClick={() => onDecline(o, reason)}>Review fee and decline</button>
        </div>
      )}
    </div>
  );
}
