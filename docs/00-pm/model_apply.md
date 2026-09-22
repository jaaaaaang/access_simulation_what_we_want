# 아파트 단지 인빌딩 통신 장비 수(SITE_COUNT) 예측 모델 적용 및 배포 검토서

## 1. 프로젝트 개요 및 모델 명세

* **프로젝트명**: 아파트 단지 인빌딩 통신 장비 수(`SITE_COUNT`) 예측 모델
* **최종 적용 모델 파일**: `no_polygon_model_lgb-mae-0.38499.pkl`
* **보조 모델 파일**: `no_polygon_model-mae-0.35034.pkl`
* **모델 목적**: 아파트 단지의 물리적 건물 정보 및 행정구역 입지 조건만을 기반으로 적정 인빌딩 통신 장비 수량(1~8개) 도출
* **성능**: Test Set MAE **0.3849** (보정 정수 기준)
* **기술 스택**: Python, Scikit-learn Pipeline, LightGBM Regressor

---

## 2. 입력 피처 스키마 및 보정 규칙

### [입력 피처 스키마 (Input Schema - 총 6개)]
1. `SEDE_CNT` (SUM) (Numeric, float/int): 단지 총 세대수 합계
2. `BLD_AREA` (SUM) (Numeric, float): 건물 총 바닥면적 합계 ($\text{m}^2$)
3. `LND_FLOOR_CNT` (MEAN) (Numeric, float): 평균 지상 층수
4. `GCHM_PK` (COUNT) (Numeric, int): 단지 내 총 동수 (건물 개수)
5. `WIDE_AREA` (Categorical, string): 광역시도 (예: `"서울특별시"`, `"경기도"`)
6. `SIGUNGU` (Categorical, string): 시군구 (예: `"마포구"`, `"성남시 분당구"`)

### [출력 및 보정 수식 (Output Post-Processing)]
1. `raw_prediction` (float): LightGBM 연속형 예측값 (예: `6.84`)
2. `final_prediction` (int): 최종 보정 정수 예측값
   * **보정 공식**: $\text{final\_pred} = \text{int}(\text{np.round}(\text{raw\_pred} + 0.05))$

---

## 3. 검토 사항 분석 결과

### [검토 사항 1] Python / Pandas 버전 상이 환경 반영 가능 여부
* **분석 결과**: **직접 피클 로드는 위험 (구동 불가능 또는 호환성 장애 위험)**
* **사유**: `pickle`은 객체의 로직이 아닌 참조 구조를 직렬화하므로, CPython 버전 차이나 `scikit-learn`, `lightgbm`, `pandas` 버전 불일치 시 `AttributeError`, `UnpicklingError`, 내부 BlockManager 연산 오류 등이 발생함.
* **해결 방안**: 모델 학습 당시 환경 버전이 명시된 격리된 전용 파이프라인/컨테이너(Docker) 구축 필수.

### [검토 사항 2] 배포 방식 비교 및 FastAPI 구축 효율성 평가

#### 방식 비교 (Python FastAPI 백엔드 vs ONNX 변환)

| 구분 | 방식 1: Python 백엔드 (`.pkl` + FastAPI) | 방식 2: ONNX 변환 (`.onnx`) |
| :--- | :--- | :--- |
| **모델 파일** | `.pkl` (Python 전용) | `.onnx` (범용 표준) |
| **전처리 호환성** | **100% 검증 완료** (`ColumnTransformer`, `OrdinalEncoder` 연산 그대로 작동) | **변환 위험성 존재** (Scikit-learn String Encoder/Imputer 변환 오류 가능성) |
| **개발 난이도** | **매우 간단** (FastAPI 엔드포인트 구축으로 즉시 사용) | **높음** (ONNX 그래프 변환 및 JS 전처리 매핑 검증 필요) |
| **보안 (IP)** | **완벽 보호** (모델 가중치가 백엔드 서버 메모리에만 존재) | **노출 위험** (React 브라우저 구동 시 `.onnx` 파일 클라이언트 다운로드) |
| **추천 여부** | **강력 추천 (실무 표준)** | 제약 조건(서버 인프라 0원) 시 선택 |

---

## 4. 권장 프로젝트 디렉토리 구조 및 파일 배치

### 디렉토리 배치 가이드
```text
playground-eng-apt-cover-windows/
├── models/                                      # [추천] AI 모델 파일(.pkl) 보관 경로
│   ├── no_polygon_model_lgb-mae-0.38499.pkl    # (최종 적용 모델)
│   └── no_polygon_model-mae-0.35034.pkl        # (보조 모델)
│
├── backend/                                     # Python FastAPI 백엔드 코드
│   ├── main.py                                  # (FastAPI 서비스 엔드포인트)
│   ├── schemas.py                               # (Pydantic DTO 정의)
│   ├── test_inference.py                        # (추론 테스트 스크립트)
│   └── requirements.txt                         # (의존성 패키지 명세)
│
├── docs/                                        # 명세서 및 가이드 문서
│   ├── APT_MODEL_SPECIFICATION.md               # (모델 상세 명세서)
│   └── model_apply.md                           # (본 적용 검토 문서)
│
└── src/                                         # React 프론트엔드 소스코드
```

### 파일 복사 명령 스니펫 (Terminal)
```bash
# 1. 대상 디렉토리 생성
mkdir -p models backend docs

# 2. 모델 및 명세서 복사
cp /Users/1109425/Downloads/pickle/no_polygon_model_lgb-mae-0.38499.pkl ./models/
cp /Users/1109425/Downloads/pickle/APT_MODEL_SPECIFICATION.md ./docs/
cp /Users/1109425/Downloads/pickle/test_inference.py ./backend/
```

---

## 5. FastAPI 백엔드 구현 명세 (`POST /api/v1/predict`)

### [DTO 정의: `backend/schemas.py`]
```python
from pydantic import BaseModel, Field

class PredictRequest(BaseModel):
    SEDE_CNT: float = Field(..., description="단지 총 세대수 합계", example=1200)
    BLD_AREA: float = Field(..., description="건물 총 바닥면적 합계 (m²)", example=45000.5)
    LND_FLOOR_CNT: float = Field(..., description="평균 지상 층수", example=25.0)
    GCHM_PK: int = Field(..., description="단지 내 총 동수", example=15)
    WIDE_AREA: str = Field(..., description="광역시도", example="서울특별시")
    SIGUNGU: str = Field(..., description="시군구", example="마포구")

class PredictResponse(BaseModel):
    raw_prediction: float = Field(..., description="LightGBM 원본 연속형 예측값")
    final_prediction: int = Field(..., description="보정 규칙 적용 최종 정수 예측값")
```

### [메인 서버: `backend/main.py`]
```python
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import pandas as pd
import pickle
import numpy as np
import os

from schemas import PredictRequest, PredictResponse

MODEL_PATH = os.getenv("MODEL_PATH", "../models/no_polygon_model_lgb-mae-0.38499.pkl")
model_pipeline = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model_pipeline
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"Model file not found at {MODEL_PATH}")
    with open(MODEL_PATH, "rb") as f:
        model_pipeline = pickle.load(f)
    print(f"[Info] Model loaded from {MODEL_PATH}")
    yield

app = FastAPI(
    title="In-building Equipment Count Prediction API",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/v1/predict", response_model=PredictResponse, summary="장비 수량 예측")
def predict_site_count(payload: PredictRequest):
    if model_pipeline is None:
        raise HTTPException(status_code=500, detail="Model pipeline is uninitialized.")

    try:
        input_dict = payload.model_dump()
        input_df = pd.DataFrame([input_dict])

        raw_pred = float(model_pipeline.predict(input_df)[0])
        final_pred = int(np.round(raw_pred + 0.05))

        return PredictResponse(
            raw_prediction=round(raw_pred, 4),
            final_prediction=final_pred
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Prediction failed: {str(e)}")
```

---

## 6. 필수 라이브러리 명세 (`requirements.txt`) 및 사내 정책 적용 가이드

### [필요 파이썬 라이브러리 명세 (`backend/requirements.txt`)]
Python FastAPI 서버 실행 및 모델 추론을 위해 필요한 라이브러리 패키지 목록입니다.

```text
fastapi>=0.100.0
uvicorn[standard]>=0.22.0
pydantic>=2.0
pandas>=1.5.0
numpy>=1.21.0
scikit-learn>=1.0.0
lightgbm>=3.3.0
```

> ⚠️ **주의사항 (라이브러리 버전 호환성)**  
> 모델 학습 시 사용된 `scikit-learn`과 `lightgbm`의 구체적인 버전에 맞춰 `requirements.txt` 버전을 지정해주어야 Pickle Unpickling 에러가 발생하지 않습니다. (학습 스크립트 실행 환경의 `pip freeze` 결과 참조 권장)

---

### [사내 배포 정책 및 프로젝트 적용 방안]

현재 본 프로젝트는 `Diyfile.yaml` 설정 파일 기준 **`service_type: javascript-npm`** (React/Vite 단일 웹 빌드 서비스)으로 등록되어 배포되고 있습니다.

따라서 사내 정책상 다음 **2가지 방식 중 하나로 적용**합니다:

#### 1️⃣ 방식 A: 사내 백엔드 앱 서비스 분리 신규 생성 (가장 권장)
* **개요**: React 프론트엔드 프로젝트(`service_type: javascript-npm`)와 Python FastAPI 백엔드 프로젝트(`service_type: python-fastapi` 또는 `docker`)를 사내 배포 시스템에서 **별개의 서비스로 독립 배포**합니다.
* **설치 위치**: 백엔드 전용 리포지토리의 루트 디렉토리에 `requirements.txt` 생성.
* **배포**: 백엔드 빌드 파이프라인에서 자동으로 `pip install -r requirements.txt` 실행.

#### 2️⃣ 방식 B: 단일 리포지토리 내 `backend/requirements.txt` 분리 구성
* **개요**: 현 리포지토리 내에 `backend/` 디렉토리를 두고 `backend/requirements.txt` 생성.
* **설치 위치**: `playground-eng-apt-cover-windows/backend/requirements.txt`
* **적용 방법**: `Diyfile.yaml` 파이프라인의 빌드 명령 또는 별도 백엔드 실행 스크립트 상에서 `pip install -r backend/requirements.txt` 명령 추가 실행.

