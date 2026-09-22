"""INSERT 재귀 전개: 모든 지오메트리를 모델 절대좌표로 평탄화."""
import math

def _xform(pt, bx, by, ix, iy, sx, sy, rot):
    x = (pt[0] - bx) * sx; y = (pt[1] - by) * sy
    c, s = math.cos(rot), math.sin(rot)
    return (ix + x * c - y * s, iy + x * s + y * c)

def flatten(model, blocks, base, max_depth=8, arc_seg=16):
    out = []  # dict: T, layer, color, depth, src, payload

    def emit(e, tf, depth, src):
        T = e['T']
        bx, by, ix, iy, sx, sy, rot = tf
        f = lambda p: _xform(p, bx, by, ix, iy, sx, sy, rot)
        col, lay = e.get(62), e.get(8, '')
        rec = dict(T=T, layer=lay, color=col, depth=depth, src=src)
        if T == 'POLYLINE' and e.get('verts'):
            rec['verts'] = [f(v) for v in e['verts']]
            rec['closed'] = bool(e.get(70, 0) & 1)
            out.append(rec)
        elif T == 'LINE':
            rec['a'] = f((e.get(10, 0), e.get(20, 0)))
            rec['b'] = f((e.get(11, 0), e.get(21, 0)))
            out.append(rec)
        elif T in ('CIRCLE', 'POINT'):
            rec['c'] = f((e.get(10, 0), e.get(20, 0)))
            rec['r'] = e.get(40, 0) * abs(sx)
            out.append(rec)
        elif T == 'ARC':
            cx, cy, r = e.get(10, 0), e.get(20, 0), e.get(40, 0)
            a0, a1 = math.radians(e.get(50, 0)), math.radians(e.get(51, 360) if 51 in e else e.get(50, 0))
            pts = []
            n = arc_seg
            if a1 < a0: a1 += 2 * math.pi
            for k in range(n + 1):
                a = a0 + (a1 - a0) * k / n
                pts.append(f((cx + r * math.cos(a), cy + r * math.sin(a))))
            rec.update(T='POLYLINE', verts=pts, closed=False)
            out.append(rec)
        elif T in ('TEXT', 'ATTRIB'):
            rec['p'] = f((e.get(10, 0), e.get(20, 0)))
            rec['h'] = e.get(40, 0) * abs(sx)
            rec['t'] = e.get(1, '')
            out.append(rec)
        elif T == 'INSERT':
            name = e.get(2)
            if name in blocks and depth < max_depth:
                nb = base.get(name, [0, 0])
                ni = f((e.get(10, 0), e.get(20, 0)))
                nsx = e.get(41, 1.0) * sx
                nsy = e.get(42, e.get(41, 1.0)) * sy
                nrot = rot + math.radians(e.get(50, 0.0))
                ntf = (nb[0], nb[1], ni[0], ni[1], nsx, nsy, nrot)
                for se in blocks[name]:
                    emit(se, ntf, depth + 1, name)

    ID = (0, 0, 0, 0, 1, 1, 0.0)
    for e in model:
        emit(e, ID, 0, None)
    return out
