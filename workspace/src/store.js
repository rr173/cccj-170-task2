import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.js';

/**
 * 版本化存储：
 *  - 全量状态保存在内存 Map 中，写穿（write-through）到 JSON 快照
 *  - 所有状态变更追加到审计日志（append-only）
 *  - 事件版本、承诺版本只增不减 —— 单调版本化由服务层在此之上保证
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
    this._saveTimer = null;
    if (this.file && fs.existsSync(this.file)) this._load();
  }

  nextSeq(kind) {
    this.state.seq[kind] = (this.state.seq[kind] || 0) + 1;
    return this.state.seq[kind];
  }

  audit(kind, details) {
    const entry = { ts: nowIso(), kind, ...details };
    this.auditTrail.push(entry);
    if (this.auditFile) {
      try {
        fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
        fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
      } catch { /* 审计文件写入失败不阻断业务 */ }
    }
    return entry;
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
