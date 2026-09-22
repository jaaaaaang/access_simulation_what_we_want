r"""AC1003+ ASCII DXF 스트리밍 파서 (ezdxf 없는 폐쇄망 환경용 순수 파이썬).
ezdxf 사용 가능 환경이면 adapter를 교체해도 동일 인터페이스.

한글 처리: DXF의 한글은 (a) 파일 인코딩(cp949 또는 utf-8), (b) AutoCAD 다바이트
이스케이프 `\M+3XXXX`(cp949 바이트쌍), (c) 유니코드 이스케이프 `\U+XXXX`
세 형태로 섞여 나온다. 이걸 복원하지 않으면 지번/동/시트타이틀 정규식이
전부 빗나가면서 '라벨 0개'로 조용히 오판한다 — 그래서 파서 단계에서 정규화한다.
"""
import math
import re
from collections import Counter

INT_CODES = {70, 62, 66, 71, 72}
FLT_CODES = {10, 20, 30, 11, 21, 31, 40, 41, 42, 43, 50}
STR_CODES = {1, 2, 3, 7, 8}

MBCS_ESC = re.compile(r'\\M\+3([0-9A-Fa-f]{4})')
UNI_ESC = re.compile(r'\\U\+([0-9A-Fa-f]{4})')
# MTEXT 서식 코드(\pxqc; \fFont; \P 줄바꿈 등) — 라벨 매칭 전에 걷어낸다.
MTEXT_FMT = re.compile(r'\\[A-Za-z][^;\\]{0,60};|\\[PpXx]|[{}]')


def decode_acad_text(s):
    """AutoCAD 이스케이프(\\M+3XXXX, \\U+XXXX)를 실제 문자로 복원."""
    if not s:
        return s
    if '\\M+' in s:
        def _m(m):
            try:
                return bytes.fromhex(m.group(1)).decode('cp949')
            except Exception:
                return m.group(0)
        s = MBCS_ESC.sub(_m, s)
    if '\\U+' in s:
        s = UNI_ESC.sub(lambda m: chr(int(m.group(1), 16)), s)
    return s


# v5 호환 alias — v5는 \U+XXXX만 처리하는 decode_dxf_unicode()를 썼다.
# decode_acad_text()가 그 상위집합(\M+3XXXX cp949 바이트쌍까지)이므로 이름만 연결한다.
decode_dxf_unicode = decode_acad_text


def strip_mtext_format(s):
    """MTEXT 서식코드 제거 (라벨 비교용). 좌표/원문에는 영향 없음."""
    return MTEXT_FMT.sub('', s) if s and '\\' in s else s


def detect_encoding(path):
    """DXF 인코딩 판정. $DWGCODEPAGE 헤더 + 실제 디코딩 성공 여부로 결정.
    utf-8로 깨끗이 읽히면 utf-8, 아니면 cp949."""
    raw = open(path, 'rb').read(4_000_000)
    try:
        raw.decode('utf-8')
        return 'utf-8'
    except UnicodeDecodeError:
        pass
    for enc in ('cp949', 'euc-kr', 'latin-1'):
        try:
            raw.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return 'cp949'


def _pairs(path, encoding=None):
    enc = encoding or detect_encoding(path)
    # errors='strict'로 먼저 시도해 손실을 감지하고, 실패하면 대체 인코딩으로 재시도한다.
    for e, errs in ((enc, 'strict'), ('cp949', 'replace')):
        try:
            with open(path, 'r', encoding=e, errors=errs) as f:
                while True:
                    c = f.readline()
                    if not c:
                        break
                    v = f.readline()
                    if not v:
                        break
                    yield c.strip(), v.rstrip('\r\n')
            return
        except UnicodeDecodeError:
            continue

# ── 유실 감지 ────────────────────────────────────────────────────────
# flatten()이 실제로 좌표를 쓰는 타입. 여기 없는 엔티티는 조용히 버려진다.
CONSUMED_TYPES = frozenset({
    'POLYLINE', 'LWPOLYLINE', 'VERTEX', 'SEQEND', 'LINE', 'CIRCLE', 'POINT',
    'ARC', 'TEXT', 'ATTRIB', 'INSERT', 'BLOCK', 'ENDBLK',
})
# 유실을 두 등급으로 나눈다. 섞으면 경고가 매번 떠서 아무도 안 본다.
#  SHAPE_LOSS: 이게 버려지면 건물·단지 '외곽선 자체'가 사라진다. R12로 다시 뽑으면
#              변환기가 폴리라인으로 테셀레이션해주므로 실제로 해결된다.
SHAPE_LOSS = frozenset({
    'SPLINE', 'ELLIPSE', 'REGION', 'BODY', '3DSOLID', 'ACAD_PROXY_ENTITY',
})
#  MINOR_LOSS: 채움·보조 도형과 미지원 텍스트. 외곽선은 대개 별도 폴리라인으로도
#              그려져 있어 결과를 바꾸지 않는다. R12 변환본에도 항상 남으므로
#              (HATCH가 SOLID로 바뀌어 들어온다) 재변환 권고 없이 참고로만 알린다.
MINOR_LOSS = frozenset({
    'HATCH', 'SOLID', '3DFACE', 'MTEXT', 'LEADER', 'MLINE', 'MULTILEADER',
})
LOSSY_TYPES = SHAPE_LOSS | MINOR_LOSS
# R12 계열은 SPLINE/ELLIPSE/LWPOLYLINE 엔티티 자체가 없어 변환기가 전부
# POLYLINE으로 테셀레이션한다 — 즉 이 버전으로 받으면 곡선 유실이 원천적으로 없다.
R12_VERSIONS = frozenset({'AC1003', 'AC1004', 'AC1006', 'AC1009'})


def lossy_report(stats, verbose=False):
    """parse()가 채운 stats로 '조용한 유실' 경고 문장들을 만든다. 없으면 빈 리스트.

    이 프로젝트에서 제일 위험한 실패는 에러가 아니라 '에러 없이 그럴듯하게 틀린
    결과'다. 곡선 엔티티를 버리고도 아무 말 없이 폴리곤을 내놓으면 정확히 그 유형이
    되므로, 형상이 사라졌으면 무엇을/어느 레이어에서 버렸는지 반드시 알린다.

    verbose=False면 SHAPE_LOSS(외곽선 유실)가 있을 때만 말한다. 채움/보조 도형은
    R12 변환본에도 항상 남아서, 같이 알리면 경고가 매번 떠 신호가 죽는다."""
    ign = stats.get('ignored') or {}
    ver = (stats.get('acadver') or '?').strip()

    def _fmt(types):
        hit = {t: lay for t, lay in ign.items() if t in types and sum(lay.values())}
        if not hit:
            return None, 0, ''
        tot = sum(sum(l.values()) for l in hit.values())
        parts = ', '.join(f"{t} {sum(l.values()):,}"
                          for t, l in sorted(hit.items(), key=lambda kv: -sum(kv[1].values())))
        lay = Counter()
        for c in hit.values():
            lay.update(c)
        return parts, tot, ', '.join(f"{n}({c:,})" for n, c in lay.most_common(3))

    out = []
    parts, tot, layers = _fmt(SHAPE_LOSS)
    if parts:
        out.append(f"⚠ 외곽선 유실 위험 — 무시된 곡선 엔티티 {tot:,}개: {parts}")
        out.append(f"   레이어: {layers}")
        if ver not in R12_VERSIONS:
            out.append("   → ODA File Converter에서 Output version을 ACAD12(R12)로 놓고 "
                       f"다시 뽑으세요. R12에는 이 엔티티들이 없어 변환기가 폴리라인으로 "
                       f"펴서 내보냅니다. (현재 {ver})")
        else:
            out.append(f"   → 이 파일은 이미 R12({ver})인데도 남아 있습니다 — "
                       "변환 설정이나 원본 도면을 확인하세요.")
    if verbose:
        parts, tot, layers = _fmt(MINOR_LOSS)
        if parts:
            out.append(f"· 무시된 채움/보조 도형 {tot:,}개: {parts}  [{layers}]")
            out.append("   (외곽선은 대개 별도 폴리라인으로도 그려져 있어 결과에는 영향 없음)")
    return out


def parse(path, encoding=None, stats=None):
    """BLOCKS+ENTITIES 파싱 → (model_entities, blocks{name:[ent]}, block_base{name:(x,y)})

    encoding=None이면 detect_encoding()으로 자동 판정한다. 절대 cp949로 고정하지 말 것 —
    utf-8 DXF를 cp949로 읽으면 한글이 조용히 깨져 라벨 매칭이 전부 실패한다.

    stats: dict를 넘기면 진단 정보를 채워준다 — acadver/encoding/ignored
    (무시한 엔티티 {타입: Counter(레이어)}). lossy_report()에 그대로 넘기면
    사람이 읽을 경고 문장이 나온다. 넘기지 않아도 동작은 동일."""
    section = None
    pending_section = False
    cur = None
    cur_block = None
    flat = []                     # (blockname|None, entity)
    base = {}
    if stats is None:
        stats = {}
    stats.setdefault('encoding', encoding or detect_encoding(path))
    stats.setdefault('acadver', None)
    ignored = stats.setdefault('ignored', {})
    hdr_key = None

    def fin(c):
        if c is None:
            return
        flat.append((cur_block, c))
        t = c.get('T')
        if t and t not in CONSUMED_TYPES:
            ignored.setdefault(t, Counter())[c.get(8) or '(레이어없음)'] += 1

    for code, val in _pairs(path, encoding):
        if code == '0':
            if val == 'SECTION':
                fin(cur); cur = None; pending_section = True; continue
            if val == 'ENDSEC':
                fin(cur); cur = None; section = None; cur_block = None; continue
            if section in ('BLOCKS', 'ENTITIES'):
                fin(cur)
                cur = {'T': val}
                if val == 'ENDBLK':
                    cur = None; cur_block = None
            else:
                fin(cur); cur = None
            continue
        if pending_section and code == '2':
            section = decode_acad_text(val); pending_section = False; continue
        # HEADER의 $ACADVER — 어떤 버전으로 내보낸 DXF인지가 유실 진단의 핵심 단서다.
        if section == 'HEADER':
            if code == '9':
                hdr_key = val
            elif code == '1' and hdr_key == '$ACADVER':
                stats['acadver'] = val.strip(); hdr_key = None
            continue
        if cur is None:
            continue
        try:
            c = int(code)
        except ValueError:
            continue
        if cur.get('T') == 'BLOCK':
            if c == 2 and 'name' not in cur:
                val = decode_acad_text(val)
                cur_block = val; cur['name'] = val; base.setdefault(val, [0.0, 0.0])
            elif c == 10 and cur_block:
                base[cur_block][0] = float(val)
            elif c == 20 and cur_block:
                base[cur_block][1] = float(val)
            continue
        # LWPOLYLINE은 POLYLINE+VERTEX와 달리 하나의 엔티티 안에서 코드 10/20이
        # 반복된다. 마지막 값만 남기면 폴리곤이 통째로 사라지므로 여기서 누적한다.
        if cur.get('T') == 'LWPOLYLINE' and c in (10, 20):
            vs = cur.setdefault('verts', [])
            try:
                fv = float(val)
            except ValueError:
                continue
            if c == 10:
                vs.append([fv, 0.0])
            elif vs:
                vs[-1][1] = fv
            continue
        if c in FLT_CODES:
            try: cur[c] = float(val)
            except ValueError: pass
        elif c in INT_CODES:
            try: cur[c] = int(val)
            except ValueError: pass
        elif c in STR_CODES:
            cur[c] = decode_acad_text(val)
    fin(cur)

    def group(seq):
        out, i = [], 0
        while i < len(seq):
            e = seq[i]
            if e['T'] == 'POLYLINE':
                verts, j = [], i + 1
                while j < len(seq) and seq[j]['T'] == 'VERTEX':
                    v = seq[j]; verts.append((v.get(10, 0.0), v.get(20, 0.0))); j += 1
                if j < len(seq) and seq[j]['T'] == 'SEQEND':
                    j += 1
                e['verts'] = verts; out.append(e); i = j
            elif e['T'] == 'LWPOLYLINE':
                # 이후 단계가 POLYLINE만 알기 때문에 같은 스키마로 바꿔 넘긴다.
                e['T'] = 'POLYLINE'
                e['verts'] = [(x, y) for x, y in e.get('verts', [])]
                out.append(e); i += 1
            elif e['T'] in ('VERTEX', 'SEQEND', 'BLOCK'):
                i += 1
            else:
                out.append(e); i += 1
        return out

    model = group([e for b, e in flat if b is None])
    blocks = {}
    for name in set(b for b, _ in flat if b):
        blocks[name] = group([e for b, e in flat if b == name])
    return model, blocks, base
