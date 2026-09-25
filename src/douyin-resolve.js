'use strict';

// ============================================
// 抖音解析编排：并行竞速 + 延迟启动窗口 + 结果缓存
//
// 旧流程是纯串行：分享页(必失败) -> 本地窗口(撞风控干等 18s) -> 再重复一遍兜底，
// 单条链接动辄 20s+。新流程改为：
//   t=0ms     并行发 HTTP 分享页线路（配了 douyinKey 再加 tjit 线路）
//   t=450ms   不管快线路成没成，都启动本地窗口抓取（快线路先成功就立刻取消它）
//   谁先成功用谁；同 ID / 同链接 5 分钟内命中缓存直接秒回
// ============================================

const douyin = require('./douyin');
const { grabDouyinVideo, cancelGrab } = require('./douyin-grab');

const CACHE_TTL_MS = 5 * 60 * 1000; // 解析结果缓存 5 分钟
const FAST_DELAY_MS = 450;           // 窗口抓取延迟启动阈值

const idCache = new Map();   // awemeId -> { ts, payload }
const urlCache = new Map();  // 原始链接 -> { ts, payload }（短链无需再跳转）

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { map.delete(key); return null; }
  return hit.payload;
}

function cacheSet(key, payload, byUrl) {
  if (!key) return;
  idCache.set(key, { ts: Date.now(), payload });
  if (byUrl) urlCache.set(byUrl, { ts: Date.now(), payload });
  if (idCache.size > 200) idCache.delete(idCache.keys().next().value);
  if (urlCache.size > 200) urlCache.delete(urlCache.keys().next().value);
}

// 错误择优：风控/验证类信息对用户最有指导价值，优先透出
function pickError(errors) {
  const list = errors.filter(Boolean);
  if (!list.length) return '抖音解析失败，请稍后重试';
  const risk = list.find(e => /验证|风控|人机|登录/.test(e));
  return (risk || list[0]).slice(0, 200);
}

// 竞速：tasks 立即并发；delayMs 后再补一条延迟任务（本地窗口）。
// 任意一路成功立即返回，其余（含延迟任务）立即取消；全部落败才返回聚合错误。
function raceWithDelayed(tasks, delayMs, makeDelayed) {
  return new Promise((resolve) => {
    let pending = tasks.length + 1; // +1 留给延迟任务，防止快线路全败后提前判负
    let settled = false;
    let delayedStarted = false;
    let skipDelayed = false;
    const errors = [];

    const finishOk = (r) => {
      if (settled) return;
      settled = true;
      skipDelayed = true;
      if (delayedStarted) cancelGrab(); // 窗口已经在跑：立刻叫停，别占资源
      resolve({ ok: true, data: r.data, source: r.source });
    };
    const failOne = (err) => {
      pending--;
      if (err) errors.push(err);
      if (!settled && pending <= 0) {
        settled = true;
        resolve({ ok: false, error: pickError(errors) });
      }
    };
    const attach = (p) => Promise.resolve(p).then(
      r => (r && r.ok ? finishOk(r) : failOne(r && r.error)),
      e => failOne(e && e.message),
    );

    tasks.forEach(attach);
    setTimeout(() => {
      if (skipDelayed) { failOne(null); return; }
      delayedStarted = true;
      attach(makeDelayed());
    }, delayMs);
  });
}

// 取出 aweme_id：链接自带则零成本；短链走一次提前退出的重定向
async function pickAwemeId(url) {
  const direct = douyin.extractAwemeId(url);
  if (direct) return direct;
  try {
    const r = await douyin.resolveUrl(url);
    return r.awemeId || douyin.extractAwemeId(r.finalUrl || '');
  } catch (_) { return null; }
}

async function resolveDouyinShare(url) {
  // 1) 链接级缓存：同一链接重复解析直接秒回（短链也省掉重定向）
  const urlHit = cacheGet(urlCache, url);
  if (urlHit) return { ok: true, data: urlHit.data, source: urlHit.source + '+cache' };

  const t0 = Date.now();

  // 2) 快线路池（不依赖 aweme_id，立即并发发出）：
  //    a) config.dyApiList 里配置的第三方接口（绕开本机 IP 风控，填 key 即启用）
  //    b) tjit（config.douyinKey）
  const tasks = [];
  for (const api of douyin.listConfiguredApis()) {
    tasks.push(
      douyin.parseViaNamedApi(url, api).then(
        d => ({ ok: !!d.videoUrl, data: d, source: 'api:' + api.name }),
        e => ({ ok: false, error: e.message }),
      ),
    );
  }
  const key = (douyin.loadConfig().douyinKey || '').trim();
  if (key) {
    tasks.push(
      douyin.parseViaTjit(url)
        .then(d => ({ ok: !!d.videoUrl, data: d, source: 'tjit' }))
        .catch(e => ({ ok: false, error: e.message })),
    );
  }

  // 3) 解析 aweme_id（短链跳转，与上面线路并行进行）+ ID 级缓存
  const awemeId = await pickAwemeId(url);
  if (awemeId) {
    const hit = cacheGet(idCache, awemeId);
    if (hit) { cacheSet(awemeId, hit, url); return { ok: true, data: hit.data, source: hit.source + '+cache' }; }
    // 本机直连分享页线路（受本机 IP 风控影响，正常网络下 0.3~0.6s 出结果）
    tasks.push(
      douyin.parseByAwemeId(awemeId).then(
        d => ({ ok: !!d.videoUrl, data: d, source: 'share' }),
        e => ({ ok: false, error: e.message }),
      ),
    );
  }

  // 4) 延迟启动本地窗口（自快线路发出起满 450ms；短链跳转已耗掉的时间计入其中）
  const delay = Math.max(0, FAST_DELAY_MS - (Date.now() - t0));
  const final = tasks.length
    ? await raceWithDelayed(tasks, delay, () => {
        if (!awemeId) return Promise.resolve({ ok: false, error: '未提取到视频ID，跳过窗口抓取' });
        return grabDouyinVideo(awemeId).then(
          r => (r && r.ok ? { ok: true, data: r.data, source: r.source || 'local' } : r),
          e => ({ ok: false, error: e && e.message }),
        );
      })
    : null;

  if (final) {
    if (final.ok) { cacheSet(awemeId, final, url); return final; }
    // 所有快线路 + 窗口都失败：最后再试一次纯第三方 parseShare（无 key 时直接返回失败）
    const r = await douyin.parseShare(url).catch(e => ({ ok: false, error: e.message }));
    if (r.ok) { cacheSet(awemeId, { ok: true, data: r.data, source: r.source }, url); return { ok: true, data: r.data, source: r.source }; }
    return final;
  }

  // 完全没有可用线路（无 aweme_id 也无第三方配置）→ 走原有兜底
  const r = await douyin.parseShare(url);
  return r.ok ? { ok: true, data: r.data, source: r.source } : r;
}

module.exports = { resolveDouyinShare, pickError, cacheSet };
