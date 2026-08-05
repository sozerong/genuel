// 그늘자리 - TAGO 버스노선정보 프록시 + 정적 파일 서버
//
// 실행:
//   export TAGO_KEY='디코딩키(원문, + 와 == 그대로)'
//   node server/proxy.mjs
//   http://localhost:8787

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = process.env.TAGO_KEY;
if (!KEY) { console.error("TAGO_KEY 환경변수가 없습니다."); process.exit(1); }

const BASE = "https://apis.data.go.kr/1613000/BusRouteInfoInqireService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// 서울은 TAGO가 다루지 않는다 (국토교통부 대상이 아니라 서울시 자체 시스템 관할).
// 매 요청마다 API를 부르는 대신, 서울 열린데이터광장 정적 덤프를 서버 시작 시 한 번 메모리에 올려둔다.
// 갱신: server/data/build-seoul-data.py 참고.
const SEOUL_CITY_CODE = "seoul";
const seoulRoutes = new Map(); // routeId -> { routeId, routeNo, stops: [{ord,name,lat,lon}] }
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "seoul-stops.json"), "utf-8"));
  for (const r of raw) {
    let route = seoulRoutes.get(r.routeId);
    if (!route) { route = { routeId: r.routeId, routeNo: r.routeNo, stops: [] }; seoulRoutes.set(r.routeId, route); }
    route.stops.push({ ord: r.ord, name: r.name, lat: r.lat, lon: r.lon });
  }
  for (const route of seoulRoutes.values()) route.stops.sort((a, b) => a.ord - b.ord);
}
const seoulRouteList = [...seoulRoutes.values()].map(r => ({
  routeId: r.routeId,
  routeNo: r.routeNo,
  start: r.stops[0]?.name ?? "",
  end: r.stops[r.stops.length - 1]?.name ?? ""
}));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// 인증 실패(cmmMsgHeader)와 일반 오류(response.header)는 코드 체계가 다르다.
// 둘 다 이 표로 사람이 읽을 수 있는 한국어 메시지로 바꾼다.
const ERR_MSG = {
  "00": "정상",
  "01": "API 서버 오류입니다.",
  "02": "데이터베이스 오류입니다.",
  "03": "요청한 데이터가 없습니다.",
  "04": "HTTP 오류입니다.",
  "05": "서비스 응답 시간이 초과됐습니다.",
  "10": "요청 파라미터가 올바르지 않습니다.",
  "11": "필수 요청 파라미터가 누락됐습니다.",
  "12": "해당 오픈API 서비스가 없습니다.",
  "20": "서비스 접근이 거부됐습니다.",
  "22": "일일 호출 한도를 초과했습니다.",
  "30": "인증키가 등록되지 않았습니다. 공공데이터포털에서 키 상태를 확인하세요.",
  "31": "인증키 유효기간이 만료됐습니다.",
  "32": "등록되지 않은 IP입니다.",
  "33": "서명되지 않은 호출입니다.",
  "99": "알 수 없는 오류입니다."
};
const errMsg = (code, fallback) => ERR_MSG[String(code)] || fallback || "알 수 없는 오류입니다.";

// 노선 경로는 거의 안 바뀐다 — 24시간 인메모리 캐시로 호출량을 줄인다.
const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

async function call(op, params) {
  const cacheKey = op + JSON.stringify(params);
  const hit = cache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.data;

  const u = new URL(`${BASE}/${op}`);
  u.searchParams.set("serviceKey", KEY);   // URL 객체가 인코딩을 처리합니다
  u.searchParams.set("_type", "json");
  u.searchParams.set("numOfRows", "300");
  u.searchParams.set("pageNo", "1");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`API 응답을 해석할 수 없습니다 (JSON이 아님): ${text.slice(0, 200)}`); }

  // 인증 실패 등은 다른 스키마로 옵니다
  const err = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (err) throw new Error(errMsg(err.returnReasonCode, err.returnAuthMsg));

  const head = json?.response?.header;
  if (head && head.resultCode !== "00") throw new Error(errMsg(head.resultCode, head.resultMsg));

  const rawItems = json?.response?.body?.items?.item;
  const items = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : []; // 결과 1건이면 객체로 옵니다

  cache.set(cacheKey, { data: items, exp: Date.now() + TTL });
  return items;
}

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end("Not found"); return; }
    res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(url.searchParams);

  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (url.pathname === "/api/cities") {
      const items = await call("getCtyCodeList", {});
      const cities = items.map(c => ({ code: String(c.citycode), name: c.cityname }));
      cities.unshift({ code: SEOUL_CITY_CODE, name: "서울특별시" });
      res.end(JSON.stringify(cities));

    } else if (url.pathname === "/api/routes") {
      if (!q.cityCode) { res.statusCode = 400; res.end(JSON.stringify({ error: "cityCode가 필요합니다." })); return; }
      if (q.cityCode === SEOUL_CITY_CODE) {
        const needle = (q.routeNo || "").toLowerCase();
        res.end(JSON.stringify(seoulRouteList.filter(r => r.routeNo.toLowerCase().includes(needle))));
        return;
      }
      const items = await call("getRouteNoList", {
        cityCode: q.cityCode,
        ...(q.routeNo ? { routeNo: q.routeNo } : {})
      });
      res.end(JSON.stringify(items.map(r => ({
        routeId: r.routeid,
        routeNo: String(r.routeno),
        start: r.startnodenm,
        end: r.endnodenm
      }))));

    } else if (url.pathname === "/api/stops") {
      if (!q.cityCode || !q.routeId) { res.statusCode = 400; res.end(JSON.stringify({ error: "cityCode와 routeId가 필요합니다." })); return; }
      if (q.cityCode === SEOUL_CITY_CODE) {
        res.end(JSON.stringify(seoulRoutes.get(q.routeId)?.stops ?? []));
        return;
      }
      const items = await call("getRouteAcctoThrghSttnList", {
        cityCode: q.cityCode,
        routeId: q.routeId
      });
      // 방향은 정류소 필드가 아니라 routeId 자체로 갈린다 (실측 확인됨. updowncd 필드 없음).
      // 반대 방향이 있으면 /api/routes 결과에 별도 routeId로 나온다.
      const stops = items
        .map(s => ({
          ord: Number(s.nodeord),
          name: s.nodenm,
          lat: Number(s.gpslati),
          lon: Number(s.gpslong)
        }))
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
      // nodeord 정렬을 신뢰하지 않고 직접 정렬합니다
      stops.sort((a, b) => a.ord - b.ord);
      res.end(JSON.stringify(stops));

    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "없는 API 경로입니다." }));
    }
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => console.log(`http://localhost:${PORT} 에서 대기 중`));
