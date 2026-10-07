import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ConjunctionService } from './services/conjunction.js';
import { ManeuverService } from './services/maneuver.js';
import { CoordinationService } from './services/coordination.js';
import { ReplayService } from './services/replay.js';
import { HttpError } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createApp({ dataFile = null, auditFile = null, screening = {} } = {}) {
  const store = new Store({ file: dataFile, auditFile });
  const conjunction = new ConjunctionService(store, { screening });
  const coordination = new CoordinationService(store);
  const maneuver = new ManeuverService(store, conjunction, coordination);
  const replay = new ReplayService(store, { auditFile });

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$');
    routes.push({ method, regex, keys, handler });
  };

  const json = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(data);
  };

  /* ---------- 目标 ---------- */
  route('POST', '/api/objects', async (req, res, { body }) => {
    json(res, 201, conjunction.createObject(body));
  });
  route('GET', '/api/objects', async (req, res) => {
    json(res, 200, [...store.state.objects.values()]);
  });
  route('GET', '/api/objects/:id', async (req, res, { params }) => {
    json(res, 200, conjunction.getObject(params.id));
  });

  /* ---------- 轨道解接收 ---------- */
  route('POST', '/api/orbit-solutions', async (req, res, { body }) => {
    const r = conjunction.ingestOrbitSolution(body);
    json(res, r.applied ? 201 : 202, r);
  });
  route('GET', '/api/orbit-solutions', async (req, res, { query }) => {
    let sols = [...store.state.solutions.values()];
    if (query.objectId) sols = sols.filter((s) => s.objectId === query.objectId);
    json(res, 200, sols.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)));
  });
  route('POST', '/api/screen', async (req, res, { body }) => {
    const touched = body?.objectId ? conjunction.rescreenObject(body.objectId) : conjunction.rescreenAll();
    json(res, 200, { touched: touched.map((t) => ({ eventId: t.event.id, appended: t.appended })) });
  });

  /* ---------- 会合事件 ---------- */
  route('GET', '/api/conjunctions', async (req, res, { query }) => {
    json(res, 200, conjunction.listEvents({ status: query.status, minRisk: query.minRisk }));
  });
  route('GET', '/api/conjunctions/:id', async (req, res, { params }) => {
    const e = conjunction.getEvent(params.id);
    json(res, 200, {
      ...e,
      candidates: [...store.state.candidates.values()].filter((c) => c.eventId === e.id),
      commitments: maneuver.listCommitments({ eventId: e.id }),
    });
  });
  route('GET', '/api/conjunctions/:id/versions/:v', async (req, res, { params }) => {
    const e = conjunction.getEvent(params.id);
    const v = e.versions.find((x) => x.version === Number(params.v));
    if (!v) throw new HttpError(404, 'NOT_FOUND', `事件 ${params.id} 无版本 ${params.v}`);
    json(res, 200, v);
  });

  /* ---------- 预警 ---------- */
  route('GET', '/api/warnings', async (req, res, { query }) => {
    json(res, 200, { generatedAt: new Date().toISOString(), warnings: conjunction.warnings(query.minLevel || 'YELLOW') });
  });

  /* ---------- 机动候选与承诺 ---------- */
  route('POST', '/api/conjunctions/:id/maneuvers', async (req, res, { params, body }) => {
    json(res, 201, maneuver.submitCandidate(params.id, body));
  });
  route('GET', '/api/maneuvers/:id', async (req, res, { params }) => {
    json(res, 200, maneuver.getCandidate(params.id));
  });
  route('POST', '/api/maneuvers/:id/approve', async (req, res, { params, body }) => {
    json(res, 201, maneuver.approveCandidate(params.id, body || {}));
  });
  route('POST', '/api/maneuvers/:id/reject', async (req, res, { params, body }) => {
    json(res, 200, maneuver.rejectCandidate(params.id, body || {}));
  });
  route('POST', '/api/commitments/:id/dispatch', async (req, res, { params, body }) => {
    json(res, 200, maneuver.dispatchCommitment(params.id, body || {}));
  });
  route('GET', '/api/commitments', async (req, res, { query }) => {
    json(res, 200, maneuver.listCommitments({ eventId: query.eventId, objectId: query.objectId }));
  });
  route('GET', '/api/commitments/:id', async (req, res, { params }) => {
    json(res, 200, maneuver.getCommitment(params.id));
  });

  /* ---------- 协同消息 ---------- */
  route('POST', '/api/coordination/messages', async (req, res, { body }) => {
    const receipt = coordination.receiveMessage(body);
    json(res, receipt.deduplicated ? 200 : 201, receipt);
  });
  route('GET', '/api/coordination/messages', async (req, res, { query }) => {
    json(res, 200, coordination.listMessages(query.eventId));
  });
  route('GET', '/api/coordination/export', async (req, res, { query }) => {
    const format = query.format === 'csv' ? 'csv' : 'json';
    const out = coordination.exportRecords({ eventId: query.eventId, format });
    if (format === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="coordination-${query.eventId || 'all'}.csv"`,
      });
      res.end(out);
    } else {
      json(res, 200, out, { 'Content-Disposition': `attachment; filename="coordination-${query.eventId || 'all'}.json"` });
    }
  });

  /* ---------- 只读审计回放 ---------- */
  route('GET', '/api/replay/chain', async (req, res) => {
    const report = replay.verifyChain();
    if (!report.ok) {
      json(res, 409, { error: {
        code: 'CHAIN_VALIDATION_FAILED',
        message: `账本哈希链校验失败（${report.errors.length} 处）`,
        details: { chain: report },
      } });
      return;
    }
    json(res, 200, report);
  });
  route('GET', '/api/replay/timeline', async (req, res, { query }) => {
    if (!query.eventId) throw new HttpError(400, 'VALIDATION', '回放必须指定 eventId（跨事件时间线不开放）');
    json(res, 200, replay.timeline(query.eventId, { minRisk: query.minRisk }));
  });
  route('GET', '/api/replay/diff', async (req, res, { query }) => {
    if (!query.eventId) throw new HttpError(400, 'VALIDATION', '差异对比必须指定 eventId（跨事件选择会被拒绝）');
    const out = replay.exportDiff(
      query.eventId,
      { seq: query.fromSeq, ts: query.fromTs, cut: query.from },
      { seq: query.toSeq, ts: query.toTs, cut: query.to },
      query.format || 'json',
      { minRisk: query.minRisk },
    );
    if (out.format === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
      });
      res.end(out.body);
    } else {
      json(res, 200, out.body, { 'Content-Disposition': `attachment; filename="${out.filename}"` });
    }
  });

  /* ---------- 审计与健康 ---------- */
  route('GET', '/api/audit', async (req, res, { query }) => {
    const limit = Number(query.limit || 200);
    json(res, 200, store.auditTrail.slice(-limit));
  });
  route('GET', '/api/health', async (req, res) => {
    json(res, 200, { status: 'ok', at: new Date().toISOString() });
  });

  /* ---------- 分析页面 ---------- */
  route('GET', '/', async (req, res) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  route('GET', '/replay', async (req, res) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'replay.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());
      const m = routes.find((r) => r.method === req.method && r.regex.test(pathname));
      if (!m) throw new HttpError(404, 'NOT_FOUND', `路由不存在: ${req.method} ${pathname}`);
      const params = {};
      const match = pathname.match(m.regex);
      m.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = JSON.parse(await readBody(req) || '{}');
      }
      await m.handler(req, res, { params, query, body });
    } catch (e) {
      if (e instanceof HttpError) {
        json(res, e.status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      } else if (e instanceof SyntaxError) {
        json(res, 400, { error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      } else {
        console.error(e);
        json(res, 500, { error: { code: 'INTERNAL', message: e.message } });
      }
    }
  });

  return { server, store, conjunction, maneuver, coordination, replay };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new HttpError(413, 'TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* 直接运行时启动服务 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8080);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const app = createApp({
    dataFile: path.join(dataDir, 'store.json'),
    auditFile: path.join(dataDir, 'audit.log'),
  });
  app.server.listen(port, () => {
    console.log(`碰撞预警与机动协同服务已启动: http://localhost:${port}`);
    console.log(`数据目录: ${dataDir}`);
  });
}
