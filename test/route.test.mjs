// route.mjs의 routeToStops()가 카카오 길찾기 응답을 buildSegments()가 먹을 수 있는
// {ord,name,lat,lon} 배열로 정확히 바꾸는지 검증한다.
// 실제 카카오 응답 스키마(routes[0].sections[].roads[].vertexes, summary.duration)를
// 그대로 흉내낸 합성 데이터를 쓴다 — 2026-08-07 실제 curl 응답으로 스키마 확인됨.
import test from "node:test";
import assert from "node:assert/strict";
import { routeToStops, geocodeTerminal } from "../server/route.mjs";
import { distKm } from "../public/geo.js";

// fetch를 잠깐 바꿔치기하고 끝나면 원래대로 돌려놓는다.
function withMockFetch(response, fn) {
  const orig = global.fetch;
  global.fetch = async () => response;
  return fn().finally(() => { global.fetch = orig; });
}
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body)
});

// 정동으로 곧게 뻗은 20km 도로, 두 개의 "도로명" 구간으로 쪼개서 준다(실제 응답 형태 흉내).
// 총 소요시간 60분으로 설정 — 15분 간격이면 정확히 0/15/30/45/60분 5개 점이 나와야 한다.
function straightRoute() {
  const lat = 37.5;
  const mkVertexes = (lon0, lon1, n) => {
    const v = [];
    for (let i = 0; i <= n; i++) v.push(lon0 + (lon1 - lon0) * (i / n), lat);
    return v;
  };
  return {
    routes: [{
      result_code: 0,
      summary: { duration: 3600, distance: 20000 },
      sections: [{
        roads: [
          { name: "A로", distance: 10000, duration: 1800, vertexes: mkVertexes(127.0, 127.1, 10) },
          // 도로 경계에서 시작점이 이전 도로의 끝점과 겹친다(실제 응답 특징) — dedup 확인용
          { name: "B로", distance: 10000, duration: 1800, vertexes: mkVertexes(127.1, 127.2, 10) }
        ]
      }]
    }]
  };
}

test("routeToStops: 60분 경로를 15분 간격으로 리샘플링하면 5개 지점이 나온다", () => {
  const stops = routeToStops(straightRoute(), 15);
  assert.equal(stops.length, 5);
  assert.equal(stops[0].name, "출발");
  assert.equal(stops.at(-1).name, "도착");
  assert.deepEqual(stops.map(s => s.ord), [1, 2, 3, 4, 5]);
});

test("routeToStops: 각 지점이 실제로 경로 위(정동 직선)에 있고 시간 간격만큼 이동했다", () => {
  const stops = routeToStops(straightRoute(), 15);
  // 정동 직선이므로 위도는 그대로, 경도만 증가해야 한다
  for (const s of stops) assert.ok(Math.abs(s.lat - 37.5) < 1e-6, `위도가 안 변해야 함, got ${s.lat}`);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i].lon > stops[i - 1].lon, "경도가 계속 증가해야 함");
  // 시간과 거리가 비례해야 한다 — 15분(전체의 1/4) 지점은 전체 거리의 1/4 지점이어야 한다
  const totalKm = distKm(stops[0], stops.at(-1));
  const km15 = distKm(stops[0], stops[1]);
  assert.ok(Math.abs(km15 - totalKm / 4) < 0.1, `15분 지점이 전체 거리의 1/4 근처여야 함, got ${km15} / 전체 ${totalKm}`);
  // 도착 지점이 실제 도로 끝점과 일치해야 한다(마지막 vertex: lon 127.2)
  assert.ok(Math.abs(stops.at(-1).lon - 127.2) < 1e-6);
});

test("routeToStops: 5분 미만 초단거리는 출발/도착 2개 지점만 낸다", () => {
  const short = {
    routes: [{
      result_code: 0,
      summary: { duration: 180, distance: 1000 },
      sections: [{ roads: [{ distance: 1000, duration: 180, vertexes: [127.0, 37.5, 127.01, 37.5] }] }]
    }]
  };
  const stops = routeToStops(short, 15);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].name, "출발");
  assert.equal(stops[1].name, "도착");
});

test("routeToStops: 실패 응답(result_code != 0)이면 null", () => {
  assert.equal(routeToStops({ routes: [{ result_code: 1, result_msg: "실패" }] }), null);
  assert.equal(routeToStops({ routes: [] }), null);
});

// --- 카카오 로컬 지오코딩 ---
test("geocodeTerminal: documents[0]의 x/y를 lon/lat으로 뒤집는다", () => {
  return withMockFetch(
    jsonResponse({ documents: [{ place_name: "센트럴시티(서울)", x: "127.0044", y: "37.5045" }] }),
    async () => {
      const coord = await geocodeTerminal("fake-key", "센트럴시티(서울)");
      assert.deepEqual(coord, { lat: 37.5045, lon: 127.0044 });
    }
  );
});

test("geocodeTerminal: 검색 결과가 없으면 null", () => {
  return withMockFetch(jsonResponse({ documents: [] }), async () => {
    const coord = await geocodeTerminal("fake-key", "존재하지않는터미널이름");
    assert.equal(coord, null);
  });
});

test("geocodeTerminal: 인증 실패면 카카오가 준 메시지를 그대로 던진다", () => {
  return withMockFetch(jsonResponse({ errorType: "AccessDeniedError", message: "invalid key" }, 401), async () => {
    await assert.rejects(
      () => geocodeTerminal("bad-key", "아무거나"),
      /invalid key/
    );
  });
});
