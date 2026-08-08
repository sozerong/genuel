// 고속/시외버스 — 정류소가 없는 노선을 "정류소 배열"로 바꿔서 시내버스와 같은 코드로 계산한다.
//
// TAGO 고속버스정보/시외버스정보 API(오픈API활용가이드 v1.1, 2026-08 확인)는 터미널
// 이름/ID와 배차시간표만 주고 좌표가 없다 — GetExpBusTrminlList/GetSuberbsBusTrminlList
// 응답 필드는 terminalId·terminalNm 딱 둘뿐이다. 그래서 카카오 로컬 키워드검색으로
// 터미널명을 좌표로 바꾼 다음(geocodeTerminal), 카카오 길찾기로 실제 도로 경로(vertexes)를
// 받아 15분 간격 "정류소"로 리샘플링한다(routeToStops). 이러면 geo.js의 buildSegments()·
// projectOntoStops(), app.js의 타임라인·좌석도·검증 코드를 전부 그대로 재사용할 수 있다 —
// "정류소 이름"이 지명 대신 "출발 N분 후"가 되는 것뿐이다.
//
// 터미널 위치·도로 둘 다 거의 안 바뀌므로 프록시에서 오래 캐싱한다.

import { distKm } from "../public/geo.js";

const KAKAO_BASE = "https://apis-navi.kakaomobility.com/v1/directions";
const KAKAO_LOCAL_BASE = "https://dapi.kakao.com/v2/local/search/keyword.json";

// 터미널명(예: "센트럴시티(서울)")으로 카카오 로컬을 검색해 가장 근접한 장소의 좌표를 낸다.
// TAGO가 좌표를 안 주는 걸 메꾸는 용도 — 못 찾으면 null(호출 쪽에서 그 터미널은 빼야 한다).
export async function geocodeTerminal(kakaoKey, name) {
  const u = new URL(KAKAO_LOCAL_BASE);
  u.searchParams.set("query", name);
  u.searchParams.set("size", "1");
  const res = await fetch(u, {
    headers: { Authorization: `KakaoAK ${kakaoKey}` },
    signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`카카오 로컬 응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`카카오 로컬 검색 실패 (HTTP ${res.status}): ${json.message || json.errorType || text.slice(0, 200)}`);

  const doc = json?.documents?.[0];
  if (!doc) return null;
  return { lat: Number(doc.y), lon: Number(doc.x) };
}

export async function fetchKakaoRoute(kakaoKey, origin, destination) {
  const u = new URL(KAKAO_BASE);
  u.searchParams.set("origin", `${origin.lon},${origin.lat}`);
  u.searchParams.set("destination", `${destination.lon},${destination.lat}`);
  const res = await fetch(u, {
    headers: { Authorization: `KakaoAK ${kakaoKey}` },
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`카카오 응답을 해석할 수 없습니다 (JSON 아님, HTTP ${res.status}): ${text.slice(0, 200)}`); }

  // 인증 실패 등은 routes 없이 {errorType, message}로 온다.
  if (!res.ok) throw new Error(`카카오 길찾기 실패 (HTTP ${res.status}): ${json.message || json.errorType || text.slice(0, 200)}`);
  const route = json?.routes?.[0];
  if (!route) throw new Error("카카오 길찾기 응답에 경로가 없습니다.");
  if (route.result_code !== 0) throw new Error(`카카오 길찾기 실패: ${route.result_msg || route.result_code}`);
  return json;
}

// intervalMin 간격으로 리샘플링한 {ord, name, lat, lon} 배열. 정류소가 2개 미만이면 null.
export function routeToStops(kakaoRes, intervalMin = 15) {
  const route = kakaoRes?.routes?.[0];
  if (!route || route.result_code !== 0) return null;

  const pts = [];
  for (const section of route.sections ?? []) {
    for (const road of section.roads ?? []) {
      const v = road.vertexes ?? [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push({ lon: v[i], lat: v[i + 1] });
    }
  }
  if (pts.length < 2) return null;

  // 도로 구간 경계에서 끝점이 겹치므로 연속 중복점을 뺀다.
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = dedup[dedup.length - 1], b = pts[i];
    if (Math.abs(a.lat - b.lat) > 1e-7 || Math.abs(a.lon - b.lon) > 1e-7) dedup.push(b);
  }
  if (dedup.length < 2) return null;

  // 누적 거리 → 각 점의 진행률. 전체 소요시간에 곱해 각 지점의 "경과시간"을 구한다.
  // (도로별 개별 duration 대신 거리 비례를 쓴다 — 도로가 아주 잘게 쪼개져 있어 충분히 정확하다)
  const cum = [0];
  for (let i = 1; i < dedup.length; i++) cum.push(cum[i - 1] + distKm(dedup[i - 1], dedup[i]));
  const totalKm = cum[cum.length - 1] || 1;
  const totalSec = route.summary.duration;
  if (!totalSec) return null;

  let j = 0;
  const pointAt = t => {
    const targetKm = (t / totalSec) * totalKm;
    while (j < cum.length - 2 && cum[j + 1] < targetKm) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const f = Math.max(0, Math.min(1, (targetKm - cum[j]) / span));
    const a = dedup[j], b = dedup[j + 1];
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  };

  const stops = [];
  const intervalSec = intervalMin * 60;
  for (let t = 0; t <= totalSec; t += intervalSec) {
    const p = pointAt(t);
    const min = Math.round(t / 60);
    // elapsedMin이 있으면 geo.js의 buildSegments()가 21km/h 가정 대신 이 실제 경과시간을 쓴다
    // — 고속도로에서 21km/h는 완전히 틀린 가정이라 이게 없으면 태양 위치 계산이 크게 어긋난다.
    stops.push({ ord: stops.length + 1, name: min === 0 ? "출발" : `출발 ${min}분 후`, lat: p.lat, lon: p.lon, elapsedMin: min });
  }
  const last = dedup[dedup.length - 1];
  const lastStop = stops[stops.length - 1];
  const totalMin = Math.round(totalSec / 60);
  if (distKm(lastStop, last) > 0.05) {
    stops.push({ ord: stops.length + 1, name: "도착", lat: last.lat, lon: last.lon, elapsedMin: totalMin });
  } else {
    lastStop.name = "도착"; lastStop.elapsedMin = totalMin;
  }
  return stops;
}
