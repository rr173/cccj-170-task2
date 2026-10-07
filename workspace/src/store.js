import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';
import { sealEntry, GENESIS_HASH, computeLegacyRoot } from './ledger.js';

/**
 * 版本化存储：
 *  - 全量状态保存在内存 Map 中，写穿（write-through）到 JSON 快照
 *  - 所有状态变更追加到审计日志（append-only），每条记录经哈希链封印（见 ledger.js）
 *  - 事件版本、承诺版本只增不减 —— 单调版本化由服务层在此之上保证
 *  - 启动时从审计日志回填，只读回放服务（replay）可独立从该账本重建协同时间线
 */
export class Store {
  constructor({ file = null, auditFile = null } = {}) {
    this.file = file;
    this.auditFile = auditFile;
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
    this.legacyEntries = [];       // 启动时回填的未封印（无哈希）旧条目
    this.malformedAuditLines = 0;  // 审计文件中无法解析的损坏行数（供链校验披露）
    this.chainHead = GENESIS_HASH;
    this.nextAuditSeq = 1;
    this._saveTimer = null;
    if (this.file && fs.existsSync(this.file)) this._load();
    if (this.auditFile && fs.existsSync(this.auditFile)) this._loadAudit();
  }

  nextSeq(kind) {
    this.state.seq[kind] = (this.state.seq[kind] || 0) + 1;
    return this.state.seq[kind];
  }

  audit(kind, details) {
    const entry = { ts: nowIso(), kind, ...details };
    // 哈希链封印：序号连续、前链哈希引用上一条封印记录（或旧账本源根）
    const sealed = sealEntry(entry, this.nextAuditSeq, this.chainHead);
    this.auditTrail.push(sealed);
    this.nextAuditSeq++;
    this.chainHead = sealed.hash;
    if (this.auditFile) {
      try {
        fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
        fs.appendFileSync(this.auditFile, JSON.stringify(sealed) + '\n');
      } catch { /* 审计文件写入失败不阻断业务 */ }
    }
    return sealed;
  }

  /** 启动回填：逐行解析追加账本（JSONL），恢复哈希链游标；损坏行计数披露 */
  _loadAudit() {
    let lines = [];
    try {
      lines = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      this.malformedAuditLines++;
      return;
    }
    let head = GENESIS_HASH;
    let sealed = 0;
    const legacy = [];
    let seenSealed = false;
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        this.malformedAuditLines++;
        continue;
      }
      if (e && typeof e.hash === 'string') {
        if (e.seq === sealed + 1) sealed = e.seq;
        head = e.hash;
        seenSealed = true;
      } else if (e && !seenSealed) {
        legacy.push(e);
      } else {
        this.malformedAuditLines++;
      }
      this.auditTrail.push(e);
    }
    if (!seenSealed) {
      head = computeLegacyRoot(legacy);
    }
    this.legacyEntries = legacy;
    this.nextAuditSeq = sealed + 1;
    this.chainHead = head;
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
