// ponytail: 설치 가능(installable) 조건만 채우는 최소 서비스워커. 오프라인 캐싱은 안 한다 —
// 이 앱은 실시간 노선 API에 의존해서 캐시된 화면이 오히려 혼란을 준다. 필요해지면 여기에 추가.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
self.addEventListener("fetch", () => {}); // 아무것도 가로채지 않음 — 네트워크로 그대로 보낸다
