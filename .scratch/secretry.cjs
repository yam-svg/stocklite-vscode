"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/data/util.ts
var https = __toESM(require("node:https"));
var EM_AGENT = new https.Agent({ keepAlive: true, ALPNProtocols: ["http/1.1"] });
function emGetText(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        agent: EM_AGENT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          ...headers
        },
        timeout: 8e3
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve(res.statusCode === 200 ? body : null));
        res.on("error", () => resolve(null));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
var StaleCache = class {
  constructor(freshTtlMs, staleTtlMs) {
    this.freshTtlMs = freshTtlMs;
    this.staleTtlMs = staleTtlMs;
  }
  value = null;
  time = 0;
  get lastSuccessTime() {
    return this.time;
  }
  async getOrFetch(fetch2) {
    const now = Date.now();
    if (this.value !== null && now - this.time < this.freshTtlMs) return this.value;
    let fresh;
    try {
      fresh = await fetch2();
    } catch {
      fresh = null;
    }
    if (fresh !== null && fresh !== void 0) {
      this.value = fresh;
      this.time = now;
      return fresh;
    }
    return this.value !== null && now - this.time < this.staleTtlMs ? this.value : null;
  }
};

// src/data/sectors.ts
var EM_REFERER = { Referer: "https://data.eastmoney.com/" };
var SECTOR_FIELDS = "f2,f3,f8,f12,f14,f62,f104,f105,f128,f136,f140,f141";
var SECTOR_HOSTS = ["https://82.push2.eastmoney.com", "https://push2.eastmoney.com", "https://push2delay.eastmoney.com", "https://33.push2.eastmoney.com"];
function optNum(o, key, fallback) {
  const v = typeof o?.[key] === "number" ? o[key] : Number(o?.[key]);
  return Number.isFinite(v) ? v : fallback;
}
async function fetchSectorList(fsT) {
  const result = [];
  let total = Number.MAX_SAFE_INTEGER;
  let page = 1;
  while (result.length < total && page <= 12) {
    if (page > 1) await new Promise((r) => setTimeout(r, 400));
    const query = `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:${fsT}&fields=${SECTOR_FIELDS}`;
    let raw = null;
    for (let attempt = 0; attempt < SECTOR_HOSTS.length * 2 && raw === null; attempt++) {
      if (attempt > 0) await sleep(Math.min(8e3, 1200 * 1.8 ** (attempt - 1)));
      raw = await emGetText(SECTOR_HOSTS[attempt % SECTOR_HOSTS.length] + query, EM_REFERER);
    }
    let data = null;
    try {
      data = raw ? JSON.parse(raw)?.data : null;
    } catch {
      data = null;
    }
    const diff = Array.isArray(data?.diff) ? data.diff : null;
    if (!diff || diff.length === 0) {
      return page === 1 || result.length === 0 ? null : result;
    }
    if (page === 1) total = optNum(data, "total", 0);
    for (const o of diff) {
      const code = String(o?.f12 ?? "");
      const name = String(o?.f14 ?? "");
      if (!code || !name) continue;
      result.push({
        code,
        name,
        price: optNum(o, "f2", NaN),
        changePct: optNum(o, "f3", NaN),
        turnoverRate: optNum(o, "f8", NaN),
        mainInflow: optNum(o, "f62", 0),
        upCount: Math.trunc(optNum(o, "f104", 0)),
        downCount: Math.trunc(optNum(o, "f105", 0)),
        leaderName: String(o?.f128 ?? ""),
        leaderCode: String(o?.f140 ?? ""),
        leaderMarket: Math.trunc(optNum(o, "f141", 0)),
        leaderPct: optNum(o, "f136", NaN)
      });
    }
    page++;
  }
  return result.length > 0 ? result : null;
}
var sectorListCaches = /* @__PURE__ */ new Map([
  [1, new StaleCache(6e4, 3 * 24 * 60 * 6e4)],
  [2, new StaleCache(6e4, 3 * 24 * 60 * 6e4)],
  [3, new StaleCache(6e4, 3 * 24 * 60 * 6e4)]
]);
function getSectorQuotes(fsT) {
  const cache = sectorListCaches.get(fsT);
  return cache ? cache.getOrFetch(() => fetchSectorList(fsT)) : Promise.resolve(null);
}

// .scratch/secretry.ts
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
void (async () => {
  console.log("\u51B7\u5374 180s \u540E\u5355\u6D4B\u677F\u5757\u884C\u4E1A\u699C\u2026");
  await sleep2(18e4);
  for (let round = 1; round <= 3; round++) {
    const list = await getSectorQuotes(2);
    const ok = !!list && list.length > 50 && list.some((s) => s.code.startsWith("BK"));
    console.log(`\u7B2C ${round} \u8F6E\uFF1A${ok ? `\u2713 \u901A\u8FC7\uFF08${list.length} \u6761\uFF09` : "\u2717 \u5931\u8D25"}`);
    if (ok) process.exit(0);
    await sleep2(3e4);
  }
  process.exit(1);
})();
