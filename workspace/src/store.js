import fs from 'node:fs';
import path from 'node:path';
import { nowIso, sha256, canonical } from './util.js';

const GENESIS_HASH = 'GENESIS';

/**
 * 版本化存储：
 *  - 全量状态保存在内存 Map 中，写穿（write-through）到 JSON 快照
 *  - 所有状态变更追加到审计账本（append-only），每条记录携带
 *    seq / prevHash / hash 形成哈希链，供只读审计回放校验
 *  - 事件版本、承诺版本只增不减 —— 单调版本化由服务层在此之上保证
 */
export class Store {
  constructor({ file = null, auditFile = null } = {}) {
    this.file = file;
    this.auditFile = auditFile;
    this.ledgerSeq = 0;
    this.lastHash = null;
    this.state = {
      objects: new Map(),        // objectId -> SpaceObject
      solutions: new Map(),      // solutionId -> OrbitSolution
      latestByObject: new Map(), // objectId -> solutionId（最新观测，按 epoch）
      events: new Map(),         // eventId -> ConjunctionEvent
      candidates: new Map(),     // candidateId -> ManeuverCandidate
      commitments: new Map(),    // commitmentId -> ManeuverCommitment
      messages: new Map(),       // messageId -> CoordinationMessage（含出站）
      receipts: new Map(),       // messageId -> 受理回执（幂等去重）
      coordApplied: new Map(),   // `${counterpartId}|${eventId}` -> 已应用的最高版本号
      outboundSeq: new Map(),    // eventId -> 出站消息本地序号
      seq: { event: 0, commitment: 0, candidate: 0, message: 0 },
    };
    this.auditTrail = [];
    this._saveTimer = null;
    if (this.auditFile && fs.existsSync(this.auditFile)) this._loadLedger();
    if (this.file && fs.existsSync(this.file)) this._load();
  }

  nextSeq(kind) {
    this.state.seq[kind] = (this.state.seq[kind] || 0) + 1;
    return this.state.seq[kind];
  }

  /** 向追加账本写一条哈希链记录（只增不改） */
  audit(kind, details = {}) {
    const seq = ++this.ledgerSeq;
    const prevHash = this.lastHash || GENESIS_HASH;
    const entry = { seq, prevHash, ts: nowIso(), kind, ...details };
    entry.hash = sha256(canonical({ seq, prevHash, ts: entry.ts, kind, ...details }));
    this.auditTrail.push(entry);
    this.lastHash = entry.hash;
    if (this.auditFile) {
      try {
        fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
        fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
      } catch { /* 审计文件写入失败不阻断业务 */ }
    }
    return entry;
  }

  /** 启动时回放磁盘账本：重建哈希链游标（损坏行跳过，由 ReplayService 校验报错） */
  _loadLedger() {
    const lines = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object' || !entry.kind) continue;
      this.auditTrail.push(entry);
      if (Number.isInteger(entry.seq)) this.ledgerSeq = Math.max(this.ledgerSeq, entry.seq);
      if (typeof entry.hash === 'string') this.lastHash = entry.hash;
    }
  }

  save() {
    if (!this.file) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this._serialize()));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('持久化失败:', e.message);
      }
    }, 50);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._serialize()));
    fs.renameSync(tmp, this.file);
  }

  _serialize() {
    const s = this.state;
    const maps = {};
    for (const k of ['objects', 'solutions', 'latestByObject', 'events', 'candidates', 'commitments', 'messages', 'receipts', 'coordApplied', 'outboundSeq']) {
      maps[k] = [...s[k].entries()];
    }
    return { maps, seq: s.seq };
  }

  _load() {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const [k, entries] of Object.entries(raw.maps)) {
      this.state[k] = new Map(entries);
    }
    this.state.seq = raw.seq || { event: 0, commitment: 0, candidate: 0, message: 0 };
  }
}
