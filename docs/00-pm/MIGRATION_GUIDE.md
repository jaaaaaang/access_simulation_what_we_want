# AI Studio App → 사내 템플릿 마이그레이션 가이드

이 문서는 AI Studio에서 개발한 Vite 기반 React 앱을 사내 `javascript-npm` 템플릿(CRA 기반)으로 안전하게 이식하고 배포하는 방법을 설명합니다.

---

## 📋 사전 체크리스트
- [ ] 사내 GitLab에 `javascript-npm` 템플릿으로 프로젝트 생성 및 로컬 clone 완료
- [ ] AI Studio 앱의 소스 코드 준비
- [ ] `Diyfile.yaml`의 `ingress.path` 확인 (예: `/x-ray-inbuilding-o2i`)
- [ ] 마이그레이션 하기전 "code_logic_comparison.md" 내용 확인, 수행.
- [ ] 마이그레이션 하기전 "enhancement_logic.md" 내용에 위배되는 사항 체크.



---

## 🛠️ 마이그레이션 5단계

### 1. 기존 CRA 파일 제거
사내 템플릿은 기본적으로 Create React App(CRA) 구조입니다. Vite 앱과 충돌하는 파일들을 먼저 삭제합니다.
```bash
rm -rf src public
```

### 2. Vite 소스 및 설정 복사
AI Studio 앱 폴더에서 다음 파일들을 사내 프로젝트 루트로 복사합니다.
- `src/` 폴더 전체
- `assets/` 폴더 (존재하는 경우)
- `index.html`
- `vite.config.ts` 및 `tsconfig.json`
- 데이터 파일 (`.json` 등)
- **중요**: `src/index.css` 또는 `src/main.css` 등 진입점에서 참조하는 스타일 파일이 누락되지 않았는지 반드시 확인하세요.

### 3. `package.json` 통합 (중요)
사내 템플릿의 `package.json`에서 `name`은 **사내 레포지토리 이름**과 일치하게 유지하되, `scripts`와 `dependencies`를 Vite 기준으로 교체합니다.

**추천 Scripts:**
```json
"scripts": {
  "start": "vite --port=3000 --host=0.0.0.0",
  "dev": "vite --port=3000 --host=0.0.0.0",
  "build": "vite build",
  "preview": "vite preview",
  "clean": "rm -rf build dist server.js"
}
```

### 4. 사내 빌드 파이프라인 최적화 (`vite.config.ts`)
사내 Tekton 파이프라인과의 호환성을 위해 `vite.config.ts`를 반드시 아래와 같이 수정해야 합니다.

> ⚠️ **중요**: `base` 경로는 레포지토리 이름이 아니라, **최초 App 생성 시 설정된 Ingress Path**와 반드시 일치해야 합니다. (한번 설정된 접속 경로는 변경할 수 없습니다.)

```typescript
export default defineConfig({
  // 1. 배포 경로 설정 (Diyfile.yaml의 ingress.path와 반드시 일치해야 함)
  // 예: 최초 설정이 /eng-apt-cover-windows 였다면 그대로 유지
  base: '/eng-apt-cover-windows/', 
  
  build: {
    // 2. 출력 디렉토리 변경 (사내 파이프라인은 'build' 폴더를 예상함)
    outDir: 'build', 
  },
  // ... 기타 설정
});
```

### 5. 의존성 잠금 및 배포
빌드 서버의 안정성을 위해 `package-lock.json`을 생성한 후 푸시합니다.
```bash
npm install
git add .
git commit -m "feat: migrate ai studio app"
git push origin master
```

---

## ⚠️ 주요 트러블슈팅
| 현상 | 원인 | 해결 방법 |
|:---:|:---|:---|
| 빌드 단계(kaniko/jenkins) 실패 | 결과물 폴더명 불일치 | `vite.config.ts`에서 `outDir: 'build'` 설정 확인 |
| 배포 후 화면 빈 칸/404 | Base Path 설정 누락 | `vite.config.ts`에서 `base` 설정 확인 |
| 스타일(CSS) 적용 안 됨 | 스타일 파일 누락 | `src/index.css` 등 진입 파일이 누락되었는지 확인 후 수동 복사 |
| 젠킨스 트리거 실패 | 프로젝트 식별자 불일치 | `Diyfile.yaml`과 `package.json`의 `name`이 레포지토리 명과 일치하는지 확인 |

---

## 🔄 지속적 업데이트 프로세스 (Sync Workflow)

이 프로젝트의 소스 코드 원본(Source of Truth)은 로컬의 다음 폴더입니다:
`//Users/1109425/access_simulation_what_we_want`

**업데이트 시나리오:**
1. 위 원본 폴더에서 코드 수정 및 기능 개발 진행
2. Gemini CLI를 통해 현재 프로젝트 폴더(`playground-eng-apt-cover-windows`)로 변경 사항 동기화 (Migration 가이드 준수)
3. 동기화 완료 후 이 레포지토리(GitLab)에 `git push` 진행

---
*v1.2 | 2026-06-11 | 동기화 워크플로우 명시*

