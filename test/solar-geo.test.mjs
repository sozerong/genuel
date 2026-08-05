// solar.js / geo.js가 reference/prototype.html의 원본 공식과 수치적으로 동일한지 확인한다.
// (TASKS.md 1번 완료 조건) 프로토타입 공식을 그대로 베껴 기준값으로 삼고, 이식본과 비교한다.
import test from "node:test";
import assert from "node:assert/strict";
import { sunPos, kstToUtc } from "../public/solar.js";
import { bearing, distKm, buildSegments } from "../public/geo.js";

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
