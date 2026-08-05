# 작업 목록

순서대로. 각 항목의 완료 조건을 채우지 못하면 다음으로 넘어가지 말 것.

---

## 0. 키 활성화 확인 · 차단 지점

```bash
export TAGO_KEY_ENCODED='...'   # 인코딩키
curl "https://apis.data.go.kr/1613000/BusRouteInfoInqireService/getCtyCodeList?serviceKey=$TAGO_KEY_ENCODED&_type=json"
```

- [ ] 도시코드 목록이 반환된다
- [ ] 천안 / 아산의 실제 도시코드를 확인해 `CLAUDE.md`에 기록한다

**코드 30(`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`)이 계속 나오면 여기서 멈추고 사용자에게 알릴 것.**
목업 데이터로 우회하거나 하드코딩 좌표를 늘리지 말 것.

---

## 1. 프로젝트 구조 세우기

프로토타입 단일 HTML을 아래로 분리한다.

```
/server
  proxy.mjs          reference/proxy.mjs 를 확장
/public
  index.html
  app.js             UI + 상태
  solar.js           sunPos, kstToUtc          ← 프로토타입에서 그대로 이식
  geo.js             bearing, distKm, buildSegments
  seatmap.js         SVG 렌더
  style.css
.env.example         TAGO_KEY=
.gitignore           .env
```

- [ ] `solar.js`, `geo.js`의 함수가 프로토타입과 **수치적으로 동일**하다 (동일 입력 → 동일 출력 테스트)
- [ ] 인증키가 `/public` 어디에도 없다

---

## 2. 프록시 완성

`reference/proxy.mjs`를 기반으로:

- [x] `/api/cities` 추가
- [x] ~~`/api/stops`에 `updown` 파라미터 (상·하행 분리)~~ — 실측 결과 `updowncd` 필드 자체가 없다. 방향은 routeId로 갈린다 (CLAUDE.md 참고). 파라미터 제거함.
- [x] 인메모리 캐시 (TTL 24시간, 키: `op+params`)
- [ ] 에러 4종 모두 처리: 코드 30 인증실패 / XML 응답 / 단건 객체 / 빈 결과
- [ ] 각 에러가 프론트에 **읽을 수 있는 한국어 메시지**로 전달된다

완료 조건: 실제 노선 하나의 정류소 좌표가 `ord` 순으로 정렬되어 나온다.

---

## 3. 노선 검색 UI

하드코딩 `ROUTES` 배열 제거.

- [x] 도시 선택 (`/api/cities`에서 로드, 기본: 천안)
- [x] 노선번호 입력 → `/api/routes` 검색 → 결과 목록
- [x] 노선 선택(방향 다르면 별도 routeId로 목록에 나옴) → 정류소 목록 로드
- [ ] 타는 곳 / 내리는 곳 선택 (내리는 곳은 타는 곳 이후만 선택 가능)
- [ ] 로딩 상태 표시, 실패 시 이유를 보여준다

---

## 4. 계산 연결

- [ ] 선택 구간의 정류소 좌표로 `buildSegments()` 호출
- [ ] 좌석 추천 / 구간 블록 / 타임라인 / 좌석도 — 프로토타입과 동일하게 렌더
- [ ] 좌표가 결측이거나 정류소가 2개 미만이면 계산하지 않고 안내

---

## 5. 다듬기

- [ ] 고도 20° 미만 구간에 신뢰도 배지
- [ ] 자주 타는 노선 저장 (localStorage)
- [ ] 모바일 레이아웃 확인 (360px 폭)
- [ ] 키보드 포커스 링, `prefers-reduced-motion`

---

## 나중에 (지금 하지 말 것)

- 버스도착정보 API(`ArvlInfoInqireService`)로 소요시간 역산
- 기상청 단기예보 하늘상태로 노출량 보정
- 건물 그림자 (건물 높이 데이터 + 레이캐스팅)
- 노선 전체 경로 폴리라인 (정류소 직선 연결이 아닌 실제 도로 형상)
