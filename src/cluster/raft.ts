import fs from "node:fs";
import { rpc } from "./transport.js";
import { ConflictError, type Entry } from "./changelog.js";
import { timings, type Member } from "./config.js";

/**
 * Leiderverkiezing en replicatie, gebaseerd op Raft:
 * - Eén leider per term; stemmen vereist een meerderheid van de stemgerechtigde leden.
 * - Een kandidaat krijgt alleen stemmen als zijn log minstens zo actueel is (witness: ≥ wat hij als duurzaam kent).
 * - Leider-lease: de leider mag schrijven tot (verzendtijd van de laatste heartbeat die een meerderheid bevestigde) + LEASE.
 *   Leden weigeren te stemmen zolang ze binnen STICKY van een leider hebben gehoord (STICKY > LEASE),
 *   dus er zijn nooit twee schrijvende leiders tegelijk.
 * Afwijking van Raft: schrijfacties worden lokaal direct vastgelegd en daarna (semi-synchroon) gerepliceerd.
 * Een afgezette leider met niet-gerepliceerde entries herstelt zich volledig vanaf de opslag (de oude database blijft bewaard).
 */

export interface DataLog {
  last(): { seq: number; term: number };
  termAt(seq: number): number | null;
  firstSeq(): number;
  entriesAfter(seq: number, max: number): Entry[];
  apply(prevSeq: number, prevTerm: number, entries: Entry[]): number;
  setTerm(term: number): void;
  setLease(until: number): void;
  ensureSequence(seq: number): void;
}

export interface RaftHooks {
  /** Leden volgens het register (alleen aangeroepen op de leider). */
  leaderMembers?: () => Member[];
  onLeader?: (term: number) => void;
  onFollower?: () => void;
  /** Lokale log wijkt af of is te ver achter: herstel vanaf opslag nodig. */
  onNeedsRestore?: (reason: string) => void;
  onAppended?: (info: { uploadedSeq: number; lastSeq: number; entries: Entry[] }) => void;
  /** Overige berichttypes (join, mail afleveren, status …). */
  onMessage?: (msg: { type: string } & Record<string, unknown>) => Promise<unknown> | unknown;
  /** Wordt in elke heartbeat meegestuurd (bijv. tot waar de opslag bijgewerkt is). */
  leaderExtras?: () => { uploadedSeq: number };
}

interface PeerState { nextSeq: number; ackSeq: number; lastAckSentAt: number; lastContact: number; inflight: boolean; needsRestoreSent: number }

interface Persisted { term: number; votedFor: string | null; members: Member[]; knownDurable: number }

export type Role = "leader" | "follower" | "candidate";

export class RaftNode {
  role: Role = "follower";
  term = 0;
  votedFor: string | null = null;
  leaderId: string | null = null;
  members: Member[] = [];
  knownDurable = 0;
  durableSeq = 0;
  lastHeard = Date.now();
  leaseUntil = 0;
  peers = new Map<string, PeerState>();
  private electionTimeout = 0;
  private timer?: NodeJS.Timeout;
  private waiters: { seq: number; resolve: (ok: boolean) => void; until: number }[] = [];
  private t = timings();
  private leaderSince = 0;
  private lastMajority = 0;
  private transferring = false;

  constructor(
    readonly self: Member,
    private key: Buffer,
    private stateFile: string,
    private log: DataLog | null,
    private hooks: RaftHooks = {},
  ) {}

  start(opts: { seeds: Member[]; bootstrapLeader?: boolean; bootstrapTerm?: number }) {
    const st = this.load();
    this.term = st?.term ?? 0;
    this.votedFor = st?.votedFor ?? null;
    this.members = st?.members?.length ? st.members : opts.seeds;
    this.knownDurable = st?.knownDurable ?? 0;
    if (!this.members.some((m) => m.id === this.self.id)) this.members = [...this.members.filter((m) => m.id !== this.self.id), this.self];
    this.resetElectionTimeout();
    if (opts.bootstrapLeader) {
      this.term = Math.max(this.term, opts.bootstrapTerm ?? 0) + 1;
      this.votedFor = this.self.id;
      this.members = [{ ...this.self, voter: true }];
      this.persist();
      this.becomeLeader();
    }
    this.timer = setInterval(() => this.tick(), this.t.heartbeat);
  }

  stop() {
    clearInterval(this.timer);
    if (this.role === "leader") this.log?.setLease(0);
  }

  isLeader() {
    return this.role === "leader" && this.leaseUntil > Date.now() && !this.transferring;
  }

  leader(): Member | undefined {
    return this.members.find((m) => m.id === this.leaderId);
  }

  voters() {
    return this.members.filter((m) => m.voter);
  }

  private majority() {
    return Math.floor(this.voters().length / 2) + 1;
  }

  // ───────── Persistentie ─────────

  private load(): Persisted | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch { return null; }
  }
  private persist() {
    const tmp = this.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ term: this.term, votedFor: this.votedFor, members: this.members, knownDurable: this.knownDurable } satisfies Persisted));
    fs.renameSync(tmp, this.stateFile);
  }

  // ───────── Klok ─────────

  private resetElectionTimeout() {
    this.electionTimeout = this.t.electionMin + Math.random() * (this.t.electionMax - this.t.electionMin);
  }

  private tick() {
    const now = Date.now();
    if (this.role === "leader") {
      this.leaderTick(now);
    } else if (this.self.kind === "data" && this.isVoter(this.self.id) && now - this.lastHeard > this.electionTimeout) {
      void this.startElection(false);
    }
    this.flushWaiters();
  }

  private isVoter(id: string) {
    const v = this.voters();
    return v.some((m) => m.id === id);
  }

  // ───────── Leider ─────────

  private becomeLeader() {
    this.role = "leader";
    this.leaderId = this.self.id;
    this.leaderSince = Date.now();
    this.lastMajority = Date.now();
    const last = this.log?.last() ?? { seq: 0, term: 0 };
    this.log?.setTerm(this.term);
    this.log?.ensureSequence(last.seq);
    this.peers.clear();
    this.updateLease(Date.now());
    console.log(`👑 ${this.self.id} is leider (term ${this.term}, seq ${last.seq})`);
    try { this.hooks.onLeader?.(this.term); } catch (e) { console.error(e); }
  }

  private stepDown(newTerm?: number) {
    const wasLeader = this.role === "leader";
    if (newTerm !== undefined && newTerm > this.term) {
      this.term = newTerm;
      this.votedFor = null;
      this.persist();
    }
    this.role = "follower";
    this.leaseUntil = 0;
    this.log?.setLease(0);
    this.lastHeard = Date.now();
    this.resetElectionTimeout();
    if (wasLeader) {
      console.log(`↘️  ${this.self.id} treedt af als leider (term ${this.term})`);
      try { this.hooks.onFollower?.(); } catch (e) { console.error(e); }
    }
  }

  private leaderTick(now: number) {
    if (this.hooks.leaderMembers) {
      const next = this.hooks.leaderMembers();
      if (!next.some((m) => m.id === this.self.id)) {
        // Wij zijn uit het cluster gehaald.
        this.members = next;
        this.persist();
        this.stepDown();
        return;
      }
      if (JSON.stringify(next) !== JSON.stringify(this.members)) {
        this.members = next;
        this.persist();
      }
    }
    for (const m of this.members) {
      if (m.id === this.self.id) continue;
      void this.sendAppend(m);
    }
    this.updateLease(now);
    if (now - this.lastMajority > this.t.electionMax) this.stepDown();
  }

  private peer(id: string): PeerState {
    let p = this.peers.get(id);
    if (!p) {
      const last = this.log?.last().seq ?? 0;
      p = { nextSeq: last + 1, ackSeq: 0, lastAckSentAt: 0, lastContact: 0, inflight: false, needsRestoreSent: 0 };
      this.peers.set(id, p);
    }
    return p;
  }

  private async sendAppend(m: Member) {
    const p = this.peer(m.id);
    if (p.inflight) return;
    p.inflight = true;
    const sentAt = Date.now();
    const term = this.term;
    try {
      let prevSeq = 0, prevTerm = 0, entries: Entry[] = [], needsRestore = false;
      if (this.log && m.kind === "data") {
        prevSeq = p.nextSeq - 1;
        const t = this.log.termAt(prevSeq);
        if (t === null || prevSeq < this.log.firstSeq() - 1) {
          // We hebben de benodigde entries niet meer: volger moet vanaf opslag herstellen.
          needsRestore = Date.now() - p.needsRestoreSent > 60_000;
          if (needsRestore) p.needsRestoreSent = Date.now();
          prevSeq = this.log.last().seq;
          prevTerm = this.log.last().term;
        } else {
          prevTerm = t;
          entries = this.log.entriesAfter(prevSeq, 500);
        }
      }
      const resp = await rpc<{ term: number; ok: boolean; accepted: boolean; lastSeq: number; conflict?: boolean }>(this.key, m.clusterUrl, {
        type: "append", term, leaderId: this.self.id, prevSeq, prevTerm, entries, needsRestore,
        durableSeq: this.durableSeq, members: this.members, ...(this.hooks.leaderExtras?.() ?? { uploadedSeq: 0 }),
      }, this.t.rpcTimeout);
      if (resp.term > this.term) return this.stepDown(resp.term);
      if (this.role !== "leader" || term !== this.term) return;
      if (resp.accepted) { p.lastAckSentAt = Math.max(p.lastAckSentAt, sentAt); p.lastContact = Date.now(); }
      if (resp.ok) {
        p.ackSeq = resp.lastSeq;
        p.nextSeq = resp.lastSeq + 1;
      } else if (!resp.conflict && m.kind === "data") {
        p.nextSeq = Math.max(1, Math.min(p.nextSeq - 1, resp.lastSeq + 1));
      }
      this.updateLease(Date.now());
    } catch {
      // onbereikbaar; volgende tick opnieuw
    } finally {
      p.inflight = false;
    }
  }

  private updateLease(now: number) {
    const voters = this.voters();
    if (!voters.some((v) => v.id === this.self.id)) { this.leaseUntil = 0; return; }
    const times = voters.map((v) => (v.id === this.self.id ? now : this.peers.get(v.id)?.lastAckSentAt ?? 0)).sort((a, b) => b - a);
    const base = times[this.majority() - 1] ?? 0;
    const until = base + this.t.lease;
    if (until > now) this.lastMajority = Math.max(this.lastMajority, base);
    if (Math.abs(until - this.leaseUntil) > 25) {
      this.leaseUntil = until;
      // Tijdens een overdracht blijft schrijven geblokkeerd, maar de lease telt wel (we blijven leider tot het doel het overneemt).
      this.log?.setLease(this.transferring ? 0 : until);
    }
    // Duurzaam = ook bij minstens één andere data-node aanwezig.
    const dataPeers = this.members.filter((m) => m.kind === "data" && m.id !== this.self.id);
    const last = this.log?.last().seq ?? 0;
    this.durableSeq = dataPeers.length ? Math.max(0, ...dataPeers.map((m) => this.peers.get(m.id)?.ackSeq ?? 0)) : last;
  }

  /** Wacht tot `seq` op minstens twee data-nodes staat (of tot timeout). */
  waitDurable(seq: number, timeoutMs = 3000): Promise<boolean> {
    if (this.durableSeq >= seq || this.role !== "leader") return Promise.resolve(this.durableSeq >= seq);
    return new Promise((resolve) => this.waiters.push({ seq, resolve, until: Date.now() + timeoutMs }));
  }

  private flushWaiters() {
    if (!this.waiters.length) return;
    const now = Date.now();
    this.waiters = this.waiters.filter((w) => {
      if (this.durableSeq >= w.seq) { w.resolve(true); return false; }
      if (now > w.until || this.role !== "leader") { w.resolve(false); return false; }
      return true;
    });
  }

  /** Geeft het leiderschap over aan een (bijgewerkte) volger, bijv. bij verhuizen. */
  async transferTo(targetId: string, timeoutMs = 15000): Promise<boolean> {
    if (this.role !== "leader") return false;
    const target = this.members.find((m) => m.id === targetId && m.voter && m.kind === "data");
    if (!target) throw new Error("Doel is geen stemgerechtigde data-node");
    // Stop met schrijven en wacht tot het doel alles heeft.
    this.transferring = true;
    this.log?.setLease(0);
    try {
      const deadline = Date.now() + timeoutMs;
      const last = this.log?.last().seq ?? 0;
      while (Date.now() < deadline && (this.peers.get(targetId)?.ackSeq ?? 0) < last) await new Promise((r) => setTimeout(r, 50));
      if ((this.peers.get(targetId)?.ackSeq ?? 0) < last) return false;
      await rpc(this.key, target.clusterUrl, { type: "timeoutNow", term: this.term, leaderId: this.self.id }, this.t.rpcTimeout).catch(() => null);
      while (Date.now() < deadline && this.role === "leader") await new Promise((r) => setTimeout(r, 50));
      return this.role !== "leader";
    } finally {
      this.transferring = false;
      if (this.role === "leader") this.log?.setLease(this.leaseUntil);
    }
  }

  // ───────── Verkiezing ─────────

  private async startElection(transfer: boolean) {
    this.role = "candidate";
    this.term++;
    this.votedFor = this.self.id;
    this.leaderId = null;
    this.persist();
    this.lastHeard = Date.now();
    this.resetElectionTimeout();
    const term = this.term;
    const last = this.log?.last() ?? { seq: 0, term: 0 };
    let votes = 1;
    const need = this.majority();
    console.log(`🗳️  ${this.self.id} vraagt stemmen (term ${term}, seq ${last.seq}, nodig ${need})`);
    if (votes >= need) return this.becomeLeader();
    await Promise.all(this.voters().filter((v) => v.id !== this.self.id).map(async (v) => {
      try {
        const r = await rpc<{ term: number; granted: boolean }>(this.key, v.clusterUrl,
          { type: "vote", term, candidateId: this.self.id, lastSeq: last.seq, lastTerm: last.term, transfer }, this.t.rpcTimeout);
        if (r.term > this.term) return this.stepDown(r.term);
        if (r.granted && this.role === "candidate" && this.term === term) {
          votes++;
          if (votes >= need) this.becomeLeader();
        }
      } catch { /* geen antwoord */ }
    }));
  }

  // ───────── Inkomende berichten ─────────

  async handle(msg: { type: string } & Record<string, unknown>): Promise<unknown> {
    switch (msg.type) {
      case "append": return this.onAppend(msg as unknown as AppendReq);
      case "vote": return this.onVote(msg as unknown as VoteReq);
      case "timeoutNow":
        if ((msg.term as number) === this.term && msg.leaderId === this.leaderId && this.self.kind === "data") void this.startElection(true);
        return { ok: true };
      case "status":
        return this.status();
      default:
        if (this.hooks.onMessage) return this.hooks.onMessage(msg);
        throw new Error("Onbekend bericht " + msg.type);
    }
  }

  private onAppend(req: AppendReq) {
    const lastSeq = () => this.log?.last().seq ?? 0;
    if (req.term < this.term) return { term: this.term, ok: false, accepted: false, lastSeq: lastSeq() };
    if (req.term > this.term) { this.term = req.term; this.votedFor = null; this.persist(); }
    if (this.role !== "follower") this.stepDown();
    this.leaderId = req.leaderId;
    this.lastHeard = Date.now();
    let dirty = false;
    if (JSON.stringify(req.members) !== JSON.stringify(this.members)) { this.members = req.members; dirty = true; }
    if (req.durableSeq > this.knownDurable) { this.knownDurable = req.durableSeq; dirty = true; }
    if (dirty) this.persist();

    if (!this.log) return { term: this.term, ok: true, accepted: true, lastSeq: 0 };
    if (req.needsRestore) {
      this.hooks.onNeedsRestore?.("leider heeft de benodigde wijzigingen niet meer");
      return { term: this.term, ok: false, accepted: true, lastSeq: lastSeq(), conflict: true };
    }
    try {
      const r = this.log.apply(req.prevSeq, req.prevTerm, req.entries);
      if (r < 0) return { term: this.term, ok: false, accepted: true, lastSeq: lastSeq() };
      this.hooks.onAppended?.({ uploadedSeq: req.uploadedSeq, lastSeq: r, entries: req.entries });
      return { term: this.term, ok: true, accepted: true, lastSeq: r };
    } catch (e) {
      if (e instanceof ConflictError) {
        this.hooks.onNeedsRestore?.(e.message);
        return { term: this.term, ok: false, accepted: true, lastSeq: lastSeq(), conflict: true };
      }
      console.error("Toepassen mislukt:", e);
      return { term: this.term, ok: false, accepted: true, lastSeq: lastSeq() };
    }
  }

  private onVote(req: VoteReq) {
    const deny = () => ({ term: this.term, granted: false });
    if (req.term < this.term) return deny();
    // Lease-respect: zolang we recent van een leider hoorden, geen stem (behalve bij een geplande overdracht).
    if (!req.transfer && this.leaderId && Date.now() - this.lastHeard < this.t.sticky) return deny();
    if (this.role === "leader" && this.leaseUntil > Date.now() && !req.transfer) return deny();
    if (this.members.length && !this.voters().some((v) => v.id === req.candidateId)) return deny();
    if (req.term > this.term) {
      this.term = req.term;
      this.votedFor = null;
      if (this.role !== "follower") this.stepDown();
      this.persist();
    }
    let upToDate: boolean;
    if (this.log) {
      const my = this.log.last();
      upToDate = req.lastTerm > my.term || (req.lastTerm === my.term && req.lastSeq >= my.seq);
    } else {
      upToDate = req.lastSeq >= this.knownDurable;
    }
    if ((this.votedFor === null || this.votedFor === req.candidateId) && upToDate) {
      this.votedFor = req.candidateId;
      this.persist();
      this.lastHeard = Date.now();
      return { term: this.term, granted: true };
    }
    return deny();
  }

  status() {
    const last = this.log?.last() ?? { seq: 0, term: 0 };
    return {
      id: this.self.id, kind: this.self.kind, role: this.role, term: this.term, leaderId: this.leaderId,
      lastSeq: last.seq, lastTerm: last.term, durableSeq: this.durableSeq, leaseUntil: this.leaseUntil,
      leaderSince: this.role === "leader" ? this.leaderSince : null,
      members: this.members,
      peers: Object.fromEntries([...this.peers].map(([id, p]) => [id, { ackSeq: p.ackSeq, lastContact: p.lastContact }])),
    };
  }
}

interface AppendReq {
  term: number; leaderId: string; prevSeq: number; prevTerm: number; entries: Entry[];
  durableSeq: number; uploadedSeq: number; members: Member[]; needsRestore?: boolean;
}
interface VoteReq { term: number; candidateId: string; lastSeq: number; lastTerm: number; transfer?: boolean }
