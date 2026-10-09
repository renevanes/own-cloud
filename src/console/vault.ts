import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, seal } from "../cluster/crypto.js";
import type { ClusterConfig } from "../cluster/config.js";

/**
 * De kluis: de beheerconfiguratie (hoofdsleutel, tokens) versleuteld met een wachtwoordzin.
 * scrypt (N=2^15, r=8) → AES-256-GCM. Het bestand mag gerust in een synchronisatiemap of back-up staan.
 */

export interface ConsoleState {
  step: string;
  done: boolean;
  keyConfirmed: boolean;
  dnsMode?: "desec" | "hetzner" | "manual";
  preset?: string;
  firstLaunch?: { at: number; nodeId: string; provider: string; region: string; clusterUrl?: string; apiUrl?: string };
  appPasswordHash?: string;
  alertEmail?: string;
  mailRelay?: string;
  spfExtra?: string;
  nameservers?: string[];
  catalog?: Record<string, Record<string, { data?: import("./catalog.js").SizeOption; witness?: import("./catalog.js").SizeOption }>>;
}

export type AdminConfig = ClusterConfig & { console: ConsoleState };

interface VaultFile { v: 1; salt: string; N: number; r: number; p: number; data: string }

const PARAMS = { N: 1 << 15, r: 8, p: 1 };

function derive(pass: string, salt: Buffer, N = PARAMS.N, r = PARAMS.r, p = PARAMS.p) {
  return crypto.scryptSync(pass.normalize("NFKC"), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
}

export class Vault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  config: AdminConfig | null = null;
  constructor(readonly file: string) {}

  exists() {
    return fs.existsSync(this.file);
  }
  unlocked() {
    return !!this.config;
  }

  create(pass: string, cfg: AdminConfig) {
    if (pass.length < 12) throw new Error("Kies een wachtwoordzin van minstens 12 tekens");
    this.salt = crypto.randomBytes(16);
    this.key = derive(pass, this.salt);
    this.config = cfg;
    this.save();
  }

  unlock(pass: string) {
    const f = JSON.parse(fs.readFileSync(this.file, "utf8")) as VaultFile;
    const salt = Buffer.from(f.salt, "base64");
    const key = derive(pass, salt, f.N, f.r, f.p);
    try {
      this.config = JSON.parse(open(key, Buffer.from(f.data, "base64"), "vault").toString("utf8"));
    } catch {
      throw new Error("Wachtwoordzin klopt niet");
    }
    this.key = key;
    this.salt = salt;
  }

  lock() {
    this.key = null;
    this.config = null;
  }

  save() {
    if (!this.key || !this.salt || !this.config) throw new Error("Kluis is op slot");
    const f: VaultFile = { v: 1, salt: this.salt.toString("base64"), ...PARAMS, data: seal(this.key, JSON.stringify(this.config), "vault").toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
