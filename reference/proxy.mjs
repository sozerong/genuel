// 그늘자리 - TAGO 버스노선정보 프록시
//
// 실행:
//   export TAGO_KEY='디코딩키(원문, + 와 == 그대로)'
//   node proxy.mjs
//
// 브라우저에서:
//   /api/routes?cityCode=34010&routeNo=400   -> 노선 검색
//   /api/stops?cityCode=34010&routeId=xxx    -> 경유 정류소 + 좌표

import http from "node:http";

const KEY = process.env.TAGO_KEY;
if (!KEY) { console.error("TAGO_KEY 환경변수가 없습니다."); process.exit(1); }

const BASE = "https://apis.data.go.kr/1613000/BusRouteInfoInqireService";

async function call(op, params) {
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
  catch { throw new Error(`JSON이 아닌 응답: ${text.slice(0, 300)}`); }

  // 인증 실패 등은 다른 스키마로 옵니다
  const err = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (err) throw new Error(`${err.returnReasonCode} ${err.returnAuthMsg}`);

  const head = json?.response?.header;
  if (head && head.resultCode !== "00") throw new Error(`${head.resultCode} ${head.resultMsg}`);

  const items = json?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];   // 결과 1건이면 객체로 옵니다
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const q = Object.fromEntries(url.searchParams);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (url.pathname === "/api/routes") {
      const items = await call("getRouteNoList", {
        cityCode: q.cityCode ?? "34010",
        ...(q.routeNo ? { routeNo: q.routeNo } : {})
      });
      res.end(JSON.stringify(items.map(r => ({
        routeId: r.routeid,
        routeNo: String(r.routeno),
        start: r.startnodenm,
        end: r.endnodenm
      }))));

    } else if (url.pathname === "/api/stops") {
      const items = await call("getRouteAcctoThrghSttnList", {
        cityCode: q.cityCode ?? "34010",
        routeId: q.routeId
      });
      // ord = 정차 순서. API가 순서를 보장하지 않아 직접 정렬합니다.
      const stops = items
        .map(s => ({
          ord: Number(s.nodeord),
          name: s.nodenm,
          lat: Number(s.gpslati),
          lon: Number(s.gpslong),
          updown: Number(s.updowncd)   // 0=상행, 1=하행
        }))
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .sort((a, b) => a.ord - b.ord);
      res.end(JSON.stringify(stops));

    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "없는 경로입니다" }));
    }
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(8787, () => console.log("http://localhost:8787 에서 대기 중"));
