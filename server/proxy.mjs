// 버스명당 - TAGO 버스노선정보 프록시 + 정적 파일 서버
//
// 실행:
//   export TAGO_KEY='디코딩키(원문, + 와 == 그대로)'
//   export KAKAO_REST_KEY='카카오 REST API 키'   (선택 — 고속/시외버스 경로 계산용)
//   node server/proxy.mjs
//   http://localhost:8787

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchKakaoRoute, routeToStops, geocodeTerminal } from "./route.mjs";

const KEY = process.env.TAGO_KEY;
if (!KEY) { console.error("TAGO_KEY 환경변수가 없습니다."); process.exit(1); }
const KAKAO_KEY = process.env.KAKAO_REST_KEY; // 없어도 서버는 뜬다 — 고속/시외버스 기능만 빠진다

const BASE = "https://apis.data.go.kr/1613000/BusRouteInfoInqireService";
const LC_BASE = "https://apis.data.go.kr/1613000/BusLcInfoInqireService";
// 오픈API활용가이드(v1.1)엔 http://로 적혀있지만 같은 기관(1613000)의 다른 서비스는 전부
// https로 잘 되므로 일단 https로 시도한다 — 실패하면 http로 바꿔야 할 수도 있다(미확인).
const EXP_BASE = "https://apis.data.go.kr/1613000/ExpBusInfo";
const SUB_BASE = "https://apis.data.go.kr/1613000/SuburbsBusInfo";

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
// 버스 실시간 위치는 반대로 계속 바뀌므로 짧은 TTL로 호출( call()의 ttl 인자로 전달)한다.
const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

// 고속/시외버스 경로(카카오 길찾기)는 도로가 바뀌지 않는 한 그대로다 — 30일 캐싱.
const routeCache = new Map();
const ROUTE_TTL = 30 * 24 * 60 * 60 * 1000;

// 터미널 좌표(카카오 로컬 지오코딩)도 터미널명 기준으로 30일 캐싱 — 터미널 위치는 안 바뀐다.
const geoCache = new Map();
const GEO_TTL = 30 * 24 * 60 * 60 * 1000;

// 고속/시외버스 배차시간표는 TAGO가 "일3회" 갱신한다고 명시 — 4시간 캐싱.
const SCHED_TTL = 4 * 60 * 60 * 1000;

async function call(op, params, { base = BASE, ttl = TTL } = {}) {
  const cacheKey = base + op + JSON.stringify(params);
  const hit = cache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.data;

  const u = new URL(`${base}/${op}`);
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

  cache.set(cacheKey, { data: items, exp: Date.now() + ttl });
  return items;
}

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end("Not found"); return; }
    res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
    // 파일이 서로 물려 있어서(app.js가 geo.js의 export를 import) 일부만 캐시된 채로 섞이면
    // 모듈 링크가 통째로 실패해 앱이 백지가 된다. 매번 최신을 받게 한다.
    res.setHeader("Cache-Control", "no-cache");
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

    } else if (url.pathname === "/api/buslocation") {
      if (!q.cityCode || !q.routeId) { res.statusCode = 400; res.end(JSON.stringify({ error: "cityCode와 routeId가 필요합니다." })); return; }
      // 서울은 TAGO 관할이 아니라 이 오퍼레이션 자체가 없다 (버스노선정보와 동일한 사정).
      if (q.cityCode === SEOUL_CITY_CODE) { res.end(JSON.stringify([])); return; }
      const items = await call(
        "getRouteAcctoBusLcList",
        { cityCode: q.cityCode, routeId: q.routeId },
        { base: LC_BASE, ttl: 15 * 1000 } // 위치는 계속 바뀌므로 캐시를 짧게 둔다
      );
      // nodeord는 정수라 그것만 쓰면 버스가 정류소에 딱 붙어 한 칸씩 튄다.
      // 실제 위치는 gpslati/gpslong으로만 알 수 있으므로 좌표도 같이 내보낸다.
      const buses = items
        .map(b => ({
          vehicleNo: b.vehicleno,
          nodeOrd: Number(b.nodeord),
          nodeName: b.nodenm,
          lat: Number(b.gpslati),
          lon: Number(b.gpslong)
        }))
        .filter(b => Number.isFinite(b.nodeOrd));
      res.end(JSON.stringify(buses));

    } else if (url.pathname === "/api/expressRoute") {
      // 고속/시외버스 — 정류소가 없으니 카카오 길찾기로 실제 도로 경로를 받아
      // 15분 간격 "정류소"로 바꾼다. 좌표만 받으므로 어느 터미널 목록 API를 쓰든 그대로 붙는다.
      if (!KAKAO_KEY) { res.statusCode = 503; res.end(JSON.stringify({ error: "카카오 REST API 키가 설정되지 않았습니다." })); return; }
      const { originLat, originLon, destLat, destLon } = q;
      if (!originLat || !originLon || !destLat || !destLon) {
        res.statusCode = 400; res.end(JSON.stringify({ error: "originLat/originLon/destLat/destLon이 필요합니다." })); return;
      }
      const origin = { lat: Number(originLat), lon: Number(originLon) };
      const destination = { lat: Number(destLat), lon: Number(destLon) };
      if (![origin.lat, origin.lon, destination.lat, destination.lon].every(Number.isFinite)) {
        res.statusCode = 400; res.end(JSON.stringify({ error: "좌표가 숫자가 아닙니다." })); return;
      }

      const cacheKey = `${origin.lat},${origin.lon}->${destination.lat},${destination.lon}`;
      const hit = routeCache.get(cacheKey);
      let stops;
      if (hit && hit.exp > Date.now()) {
        stops = hit.data;
      } else {
        const kakaoRes = await fetchKakaoRoute(KAKAO_KEY, origin, destination);
        stops = routeToStops(kakaoRes, 15);
        if (!stops) throw new Error("경로에서 정류소를 만들 수 없습니다.");
        routeCache.set(cacheKey, { data: stops, exp: Date.now() + ROUTE_TTL });
      }
      res.end(JSON.stringify(stops));

    } else if (url.pathname === "/api/expressTerminals") {
      // 고속/시외버스 터미널 검색. TAGO 원본을 그대로 다 내보낸다 — 검색 결과 하나하나를
      // 지오코딩해서 붙이면 카카오가 못 찾는 이름은 조용히 빠져서 "검색이 덜 나온다"는
      // 문제가 생긴다(실제로 겪음). 좌표는 사용자가 실제로 고른 2곳만 /api/geocode로 나중에 구한다.
      const type = q.type === "suburbs" ? "suburbs" : q.type === "exp" ? "exp" : null;
      if (!type) { res.statusCode = 400; res.end(JSON.stringify({ error: "type은 exp 또는 suburbs여야 합니다." })); return; }
      if (!q.keyword) { res.statusCode = 400; res.end(JSON.stringify({ error: "keyword가 필요합니다." })); return; }

      const op = type === "exp" ? "GetExpBusTrminlList" : "GetSuberbsBusTrminlList";
      const base = type === "exp" ? EXP_BASE : SUB_BASE;
      const params = { terminalNm: q.keyword };
      if (type === "suburbs" && q.cityCode) params.cityCode = q.cityCode;
      const items = await call(op, params, { base, ttl: TTL });

      // 활용가이드는 camelCase(terminalId)로 적혀있지만 이 API 계열은 실제 JSON 응답이
      // 소문자로 오는 걸 여러 번 겪었다(nodeord, gpslati 등) — 둘 다 받는다.
      // 같은 이름(예: "동서울")이 운수회사별로 ID만 다르게 여러 개 나온다 — 사용자한텐
      // 물리적으로 같은 터미널이라 이름 하나로 묶는다. ID는 배열로 들고 있다가 배차조회 때
      // 전부 물어봐야 한다(회사별로 배차가 나뉘어 있어서 하나만 물으면 절반이 빠진다).
      const byName = new Map();
      for (const it of items) {
        const id = it.terminalid ?? it.terminalId;
        const name = it.terminalnm ?? it.terminalNm;
        if (!id || !name) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(id);
      }
      const terminals = [...byName.entries()].map(([name, ids]) => ({ name, ids }));
      res.end(JSON.stringify(terminals));

    } else if (url.pathname === "/api/geocode") {
      // 선택된 터미널 하나의 좌표만 이때 구한다 — 검색 결과 전부를 지오코딩하지 않는다.
      if (!KAKAO_KEY) { res.statusCode = 503; res.end(JSON.stringify({ error: "카카오 REST API 키가 설정되지 않았습니다." })); return; }
      if (!q.name) { res.statusCode = 400; res.end(JSON.stringify({ error: "name이 필요합니다." })); return; }

      const hit = geoCache.get(q.name);
      let coord;
      if (hit && hit.exp > Date.now()) {
        coord = hit.data;
      } else {
        coord = await geocodeTerminal(KAKAO_KEY, q.name);
        geoCache.set(q.name, { data: coord, exp: Date.now() + GEO_TTL });
      }
      if (!coord) { res.statusCode = 404; res.end(JSON.stringify({ error: `"${q.name}"의 위치를 찾을 수 없습니다.` })); return; }
      res.end(JSON.stringify(coord));

    } else if (url.pathname === "/api/expressSchedule") {
      // 고속/시외버스 배차시간표. depTerminalId/arrTerminalId는 콤마로 여러 개 올 수 있다 —
      // 이름은 같은데 운수회사별로 ID가 나뉜 터미널(/api/expressTerminals가 묶어서 내보낸 것)이라
      // 전부 물어보고 합쳐야 배차가 안 빠진다.
      const type = q.type === "suburbs" ? "suburbs" : q.type === "exp" ? "exp" : null;
      if (!type) { res.statusCode = 400; res.end(JSON.stringify({ error: "type은 exp 또는 suburbs여야 합니다." })); return; }
      if (!q.depTerminalId || !q.arrTerminalId || !q.date) {
        res.statusCode = 400; res.end(JSON.stringify({ error: "depTerminalId/arrTerminalId/date가 필요합니다." })); return;
      }
      const op = type === "exp" ? "GetStrtpntAlocFndExpbusInfo" : "GetStrtpntAlocFndSuberbsBusInfo";
      const base = type === "exp" ? EXP_BASE : SUB_BASE;
      const depIds = q.depTerminalId.split(",").filter(Boolean);
      const arrIds = q.arrTerminalId.split(",").filter(Boolean);

      const items = [];
      for (const depTerminalId of depIds) {
        for (const arrTerminalId of arrIds) {
          items.push(...await call(op, { depTerminalId, arrTerminalId, depPlandTime: q.date }, { base, ttl: SCHED_TTL }));
        }
      }

      // YYYYMMDDHHMI -> "YYYY-MM-DDTHH:MI" 프론트가 바로 Date로 쓸 수 있게.
      const toIso = t => {
        const s = String(t);
        if (s.length < 12) return null;
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}`;
      };
      const seen = new Set();
      const schedule = items.map(it => ({
        routeId: it.routeid ?? it.routeId,
        grade: it.gradenm ?? it.gradeNm,
        depTime: toIso(it.depplandtime ?? it.depPlandTime),
        arrTime: toIso(it.arrplandtime ?? it.arrPlandTime),
        depPlace: it.depplacenm ?? it.depPlaceNm,
        arrPlace: it.arrplacenm ?? it.arrPlaceNm,
        charge: Number(it.charge)
      }))
        .filter(s => s.depTime)
        .filter(s => { // ID 조합을 여러 번 물어봤으니 같은 배차가 겹칠 수 있다
          const key = s.routeId + s.depTime;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        })
        .sort((a, b) => a.depTime < b.depTime ? -1 : a.depTime > b.depTime ? 1 : 0);
      res.end(JSON.stringify(schedule));

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
