# arm-collector

Agent Reliability Monitor(ARM) collector의 **읽기 전용 배포 미러**다. Claude Code·Codex 실행의 최소 실행 증거를 수집해 본인의 ARM 서버로 전송하는 SDK/CLI를 담는다. raw prompt·소스 코드·도구 출력·절대경로는 수집하지 않으며, allowlist에 등록된 typed metadata만 담아 HTTPS로 보낸다.

## 이 저장소는 미러다

- 이 저장소의 내용은 비공개 ARM 저장소(`jjongguet/agent-reliability-monitor`)의 ARM CI(ARC)가 `main` 머지마다 **생성해서 push**한다. collector 소스(`packages/{core,collector,adapters}`), 그 테스트, 미리 빌드된 `dist/`, 그리고 파일별 sha256과 원본 commit을 담은 `MIRROR-MANIFEST.json`이 함께 실린다.
- 손으로 편집한 내용은 다음 생성에서 사라진다. **개발과 변경은 ARM 저장소에서만 하며, 이 저장소의 PR은 리뷰·머지되지 않는다.** ARM 저장소는 비공개이므로 설치·연결 문제 신고는 이 저장소의 이슈로 받고, 수정은 ARM에서 이뤄져 다음 미러 생성에 실린다(`docs/privacy.md` 지원 채널과 같다).
- 검증은 push **전에** ARM ARC에서 끝난다: 타입 검사, 테스트, 빌드, `npm pack`, 임시 prefix 설치, 설치된 실행 파일의 `status` 확인. 공개 저장소는 ARC 러너를 쓸 수 없어 이 저장소에는 CI가 없고, `.github/` 디렉터리도 포함되지 않는다.

## 요구 사항

collector는 `engines` 기준 Node ≥24.15가 필요하다(모든 이후 minor 호환성을 검증한 것은 아님). ARM 호스팅 런타임 자체의 요구사항은 Node ≥22이며 collector의 Node 바닥값과 별개다.

## 설치

### GitHub 태그에서 설치 (권장)

```sh
npm i -g "https://codeload.github.com/jjongguet/arm-collector/tar.gz/refs/tags/v0.1.1"
arm-collector status --dir "$HOME/.agent-reliability-monitor/private"
```

`github:` 형식(`npm i -g github:jjongguet/arm-collector#v0.1.1`)은 npm 11에서 전역 설치 후 실행 파일이 사라지므로 태그 tarball URL을 쓴다.


빌드된 `dist/`가 저장소에 함께 실리므로 설치 시 TypeScript 컴파일이나 개발 의존성 설치가 필요 없다. 설치 시 네트워크에서 받는 것은 런타임 의존성(`zod`)뿐이다.

### 로컬 tarball에서 설치

```sh
npm pack                                  # arm-collector-0.1.1.tgz 생성
npm i -g ./arm-collector-0.1.1.tgz
```

### clone해서 쓰기

```sh
git clone https://github.com/jjongguet/arm-collector.git "$HOME/arm-collector"
cd "$HOME/arm-collector"
npm ci
npm run collector -- status --dir "$HOME/.agent-reliability-monitor/private"
```

## ARM 서버 연결

`--origin`에는 본인이 사용하는 ARM 서버의 정확한 origin을 직접 넣는다. 이 값은 사용자 입력이며 이 저장소에 기본 origin은 내장돼 있지 않다. `--approve-origin` 없이는 어떤 origin과도 연결하지 않는다.

```sh
ARM_STATE="$HOME/.agent-reliability-monitor/private"
ARM_ORIGIN="https://YOUR_MONITOR_ORIGIN"  # 본인 ARM 서버 origin으로 교체

arm-collector connect --origin "$ARM_ORIGIN" --approve-origin --dir "$ARM_STATE"
# 출력 JSON의 code를 ARM 웹 대시보드에서 프로젝트를 선택해 승인한 뒤 다음으로 이어진다
arm-collector redeem --dir "$ARM_STATE"
arm-collector status --dir "$ARM_STATE"
```

상태 디렉터리는 본인 소유의 비공개 경로(0700)로 두고 모든 명령에서 같은 `--dir`를 쓴다. symlink 경로는 거부된다. `pairing.json`·기기 토큰은 비밀이며 공유·커밋 대상이 아니다.

## 사용법

`setup`은 변경 사항을 먼저 미리보기로 출력하고, `--apply`를 붙여야 실제로 프로젝트에 Stop hook을 설치한다. 이 SDK는 launchd·cron·systemd 같은 호스트 상주 서비스를 스스로 설치하지 않는다.

| 명령 | 동작 |
| --- | --- |
| `connect --origin URL --approve-origin` | pairing 코드 발급(1회용, 10분) |
| `redeem` | 대시보드 승인 후 기기 자격 증명 수령 |
| `status` | 연결·spool 상태 JSON |
| `report` | 로컬 판정 요약 |
| `flush` | opt-in 전송. 호출 1회당 최대 100개·256KiB 배치 1건 |
| `worker --opt-in` | 포그라운드에서 주기적으로 flush(기본 1초, 100ms~60s) |
| `rotate` | 기기 자격 증명 회전(이전 즉시 무효) |
| `disconnect` | 서버 자격 증명 폐기 + 로컬 자격 증명·spool 제거 |
| `setup --host claude-code --project PATH [--apply\|--uninstall]` | 프로젝트 범위 `.claude/settings.local.json`에 marker 항목만 추가/제거 |
| `receive --host claude-code\|codex` | hook 수신(stdin 3초·256KB 상한) |
| `codex-fixture --opt-in [--passing] [--capability-probe]` | controlled owned fixture 프로브 |
| `codex-exec --opt-in --project PATH --scope FILES --tests FILES -- PROMPT` | 승인 범위 명시 실행 wrapper |
| `isolated-test --opt-in --project PATH` | 고정 macOS 격리 profile 실행 |

## 로컬 spool 한도

- spool은 최대 **500개 이벤트 또는 1MiB**(직렬화 크기)까지 보관한다. 넘으면 새 이벤트는 버려지고 `lost`로 집계되며 관측 공백으로 남는다.
- 보관 기간은 **7일**이다. 지난 이벤트는 flush 시점에 `lost`로 옮겨진 뒤 삭제된다.
- 한 번의 `flush`는 최대 100개·256KiB 한 건만 보낸다. 대기열이 100개보다 많으면 `flush`를 반복해서 비운다.
- 권장 주기: 작업 세션마다 1회, 최소 하루 1회. 하루 발생량이 100건을 넘으면 `worker --opt-in`을 포그라운드로 띄워 두고, 수동 실행을 선호하면 `status`의 `queued`가 0이 될 때까지 `flush`를 반복한다.

## 버전과 태그

- 패키지 버전은 `package.json`의 `version`이 단일 출처이고 태그는 `v<version>`이다. 설치 예시의 태그와 버전은 함께 움직인다.
- 태그는 ARM CI가 **없을 때만 새로 만든다**. 이미 있는 태그를 이동·덮어쓰지 않는다.
- 같은 버전의 태그가 이미 있고 배포 페이로드(`package.json`, `dist/`, `README.md`, `LICENSE`)가 달라지면 push는 실패한다. 그때는 ARM에서 미러 버전을 올려 새 태그를 만든다.
- npm registry publish는 없다(오너 결정 대기). 배포 채널은 GitHub 태그와 tarball뿐이다.

## 프라이버시

- raw prompt·소스/args·출력·절대경로·PII를 저장·전송하지 않는다. 메모리에서 bounded 파싱 후 allowlisted typed metadata(HMAC 식별자 포함)만 로컬 spool과 전송 본문에 남긴다.
- provider(Claude/Codex) 자격증명을 수집·사용하지 않는다.
- 기기 토큰은 서버에 hash만 저장되고, pairing 코드는 1회용이다. revoke 시 즉시 거부된다.
- 로컬 개인 상태 디렉터리는 0700/0600 권한으로 만들고 symlink를 거부한다.
- 서버 측 보존·한도는 본인 ARM 서버 정책을 따른다(무료 플랜 10,000 이벤트/일, 이벤트 7일 보존).

## 라이선스

MIT — [LICENSE](LICENSE)
