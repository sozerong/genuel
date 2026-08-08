// solar.js / geo.js가 reference/prototype.html의 원본 공식과 수치적으로 동일한지 확인한다.
// (TASKS.md 1번 완료 조건) 프로토타입 공식을 그대로 베껴 기준값으로 삼고, 이식본과 비교한다.
import test from "node:test";
import assert from "node:assert/strict";
import { sunPos, kstToUtc } from "../public/solar.js";
import { bearing, distKm, buildSegments, projectOntoStops } from "../public/geo.js";

// --- reference/prototype.html 원본 공식 (검증 기준) ---
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function refSunPos(utcMs, lat, lon) {
  const n = utcMs / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lmst = gmst * 15 + lon;
  let H = (lmst - ra * R2D);
  H = (((H + 180) % 360) + 360) % 360 - 180;
  const Hr = H * D2R, la = lat * D2R;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(Hr)) * R2D;
  let az = Math.atan2(-Math.sin(Hr), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(Hr)) * R2D;
  az = (az + 360) % 360;
  return { alt, az };
}
const refKstToUtc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi);
function refBearing(a, b) {
  const φ1 = a[0] * D2R, φ2 = b[0] * D2R, Δλ = (b[1] - a[1]) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
function refDistKm(a, b) {
  const R = 6371, dφ = (b[0] - a[0]) * D2R, dλ = (b[1] - a[1]) * D2R;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const CASES = [
  { utc: Date.UTC(2026, 5, 21, 3, 0), lat: 36.8095, lon: 127.1487 },  // 하지 정오 KST
  { utc: Date.UTC(2026, 0, 5, 7, 0), lat: 36.7943, lon: 127.1044 },   // 오후 4시 KST 겨울
  { utc: Date.UTC(2026, 8, 22, 21, 0), lat: 36.8151, lon: 127.1139 } // 밤
];

test("sunPos는 프로토타입 원본 공식과 동일한 값을 낸다", () => {
  for (const c of CASES) {
    const a = sunPos(c.utc, c.lat, c.lon);
    const b = refSunPos(c.utc, c.lat, c.lon);
    assert.equal(a.alt, b.alt);
    assert.equal(a.az, b.az);
  }
});

test("kstToUtc는 프로토타입 원본과 동일하다", () => {
  assert.equal(kstToUtc(2026, 8, 5, 16, 0), refKstToUtc(2026, 8, 5, 16, 0));
});

test("bearing/distKm은 프로토타입 원본 공식과 동일한 값을 낸다", () => {
  const a = { lat: 36.8095, lon: 127.1487 }, b = { lat: 36.7943, lon: 127.1044 };
  assert.equal(bearing(a, b), refBearing([a.lat, a.lon], [b.lat, b.lon]));
  assert.equal(distKm(a, b), refDistKm([a.lat, a.lon], [b.lat, b.lon]));
});

test("buildSegments: 정남북 구간은 태양 남중 시각엔 측면광이 거의 없고, 오후 5시엔 뚜렷해진다", () => {
  // 경도 고정, 위도만 다른 순수 남북 구간 — 남중 시각엔 해가 정면/후면에 있어 sinΔ≈0
  const stops = [
    { name: "A", lat: 36.70, lon: 127.10 },
    { name: "B", lat: 36.75, lon: 127.10 }
  ];
  const noon = buildSegments(stops, 2026, 6, 21, 12, 30)[0]; // 대략적 태양 남중 시각(KST)
  const noonInten = Math.abs(noon.sinD) * Math.cos(noon.alt * D2R);
  assert.ok(noonInten < 0.13, `태양 남중 근처 측면 유입 강도가 낮아야 함, got ${noonInten}`);

  const evening = buildSegments(stops, 2026, 6, 21, 17, 0)[0];
  const eveningInten = Math.abs(evening.sinD) * Math.cos(evening.alt * D2R);
  assert.ok(eveningInten >= 0.13, `오후 5시 측면 유입 강도가 뚜렷해야 함, got ${eveningInten}`);
  assert.ok(eveningInten > noonInten, "오후 5시가 남중 시각보다 측면 유입이 강해야 함");
});

// --- 버스 GPS 투영 ---
// nodeord만 쓰던 옛 로직은 버스를 늘 정류소에 붙여놨다(보간이 항상 0). 좌표로 사이 위치를 내는지 확인한다.
test("projectOntoStops: 정류소 사이 버스의 소수 위치를 GPS로 낸다", () => {
  // 남북으로 곧게 뻗은 3개 정류소 (경도 동일, 위도 0.01씩)
  const stops = [
    { ord: 5, name: "A", lat: 36.70, lon: 127.10 },
    { ord: 6, name: "B", lat: 36.71, lon: 127.10 },
    { ord: 7, name: "C", lat: 36.72, lon: 127.10 }
  ];

  // B를 막 지나 C로 30% 지점에 있는 버스
  const mid = projectOntoStops({ nodeOrd: 6, lat: 36.713, lon: 127.10 }, stops);
  assert.ok(Math.abs(mid - 1.3) < 0.01, `1.3 근처여야 함, got ${mid}`);

  // 정류소 B에 정확히 서 있는 버스
  const atStop = projectOntoStops({ nodeOrd: 6, lat: 36.71, lon: 127.10 }, stops);
  assert.ok(Math.abs(atStop - 1) < 0.01, `1 근처여야 함, got ${atStop}`);

  // B 직전(A→B 80% 지점)이라 보고된 정류소보다 뒤에 있는 버스
  const before = projectOntoStops({ nodeOrd: 6, lat: 36.708, lon: 127.10 }, stops);
  assert.ok(Math.abs(before - 0.8) < 0.01, `0.8 근처여야 함, got ${before}`);

  // 좌표가 없으면 정류소에 스냅한다 (API가 GPS를 안 줄 때의 후퇴 경로)
  assert.equal(projectOntoStops({ nodeOrd: 7 }, stops), 2);

  // 노선에 없는 순번이면 그리지 않도록 null
  assert.equal(projectOntoStops({ nodeOrd: 99, lat: 36.71, lon: 127.10 }, stops), null);
});

// --- 고속버스: elapsedMin이 있으면 21km/h 가정 대신 실제 경과시간을 쓴다 ---
test("buildSegments: elapsedMin이 있으면 거리(21km/h) 대신 그 값으로 구간 시간을 낸다", () => {
  // 정동으로 200km 떨어진 두 정류소. 21km/h면 570분 넘게 걸리지만,
  // 고속도로 실제 소요시간(elapsedMin)은 90분이라고 알려준다.
  const withElapsed = [
    { name: "출발", lat: 37.5, lon: 127.0, elapsedMin: 0 },
    { name: "도착", lat: 37.5, lon: 128.8, elapsedMin: 90 }
  ];
  const segs = buildSegments(withElapsed, 2026, 6, 21, 6, 0);
  assert.equal(segs.length, 1);
  assert.ok(Math.abs(segs[0].dur - 90) < 0.01, `elapsedMin(90분)을 그대로 써야 함, got ${segs[0].dur}`);
});

test("buildSegments: elapsedMin이 없으면(시내버스) 기존처럼 21km/h로 추정한다", () => {
  // 정동으로 대략 1.85km 떨어진 두 정류소(경도 0.021도 근방, 위도 37.5)
  const noElapsed = [
    { name: "A", lat: 37.5, lon: 127.000 },
    { name: "B", lat: 37.5, lon: 127.021 }
  ];
  const segs = buildSegments(noElapsed, 2026, 6, 21, 6, 0);
  const km = distKm(noElapsed[0], noElapsed[1]);
  const expected = km / 21 * 60 + 0.5; // SPEED=21, DWELL=0.5 (geo.js와 동일한 공식)
  assert.ok(Math.abs(segs[0].dur - expected) < 0.01, `기존 21km/h 공식과 같아야 함, got ${segs[0].dur} vs ${expected}`);
});
