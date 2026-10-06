import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 规范化 JSON（键排序），用于快照哈希 */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
      throw new HttpError(400, 'VALIDATION', `缺少必填字段: ${f}`);
    }
  }
}

export function isIsoDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

export function requireIsoDate(s, name) {
  if (!isIsoDate(s)) throw new HttpError(400, 'VALIDATION', `字段 ${name} 不是合法 ISO 时间: ${s}`);
}

export function requireNumber(v, name, { min = -Infinity, max = Infinity } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new HttpError(400, 'VALIDATION', `字段 ${name} 必须是有限数字`);
  }
  if (v < min || v > max) throw new HttpError(400, 'VALIDATION', `字段 ${name} 超出范围 [${min}, ${max}]`);
}

/* ---------- 矩阵工具 ---------- */
export function matT(A) {
  const n = A.length, m = A[0].length;
  const T = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j][i] = A[i][j];
  return T;
}

export function matMul(A, B) {
  const n = A.length, k = B.length, m = B[0].length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++) {
      const a = A[i][p];
      if (a === 0) continue;
      for (let j = 0; j < m; j++) C[i][j] += a * B[p][j];
    }
  return C;
}

export function validateMatrix(M, rows, cols, name) {
  if (!Array.isArray(M) || M.length !== rows || M.some((r) => !Array.isArray(r) || r.length !== cols || r.some((x) => typeof x !== 'number' || !Number.isFinite(x)))) {
    throw new HttpError(400, 'VALIDATION', `字段 ${name} 必须是 ${rows}x${cols} 的有限数值矩阵`);
  }
}

/* ---------- CSV ---------- */
export function toCsv(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
