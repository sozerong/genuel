// 태양 위치 — NOAA 저정밀 알고리즘 (오차 ±0.02°). prototype.html에서 수치적으로 동일하게 이식.
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function sunPos(utcMs, lat, lon) {
  const n = utcMs / 86400000 + 2440587.5 - 2451545.0;      // J2000 기준 일수
  const L = (280.460 + 0.9856474 * n) % 360;                // 평균황경
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;        // 평균근점이각
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;               // 황도경사
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

/* KST 벽시계 → UTC ms. 브라우저 로컬 타임존에 의존하지 않는다. */
export const kstToUtc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi);
