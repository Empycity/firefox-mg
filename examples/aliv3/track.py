# -*- coding: utf-8 -*-
# @Time    : 2026/4/23 11:44
# @Author  : dandan
# @FileName: track.py
# @Software: PyCharm
# -*- coding: utf-8 -*-
"""
阿里 FeiLin V3 变速滑块验证码 — 轨迹生成器

输入 xPos（缺口像素位置），输出完整 TrackList。

核心变速公式：
  正向: puzzle_pos = round(slider_dist * (slider_dist + 20) / 280)
  逆向: slider_dist = round(-10 + √(100 + 280 * gap_x))

字段关系（从 10 组真实成功轨迹逆向得出）：
  mc[3] 坐标 == mm[0] 坐标    (mousedown 位置)
  mu[3]      == mm[-2]         (held 位置，坐标+时间完全一致)
  mu[3].x - mc[3].x == slidePos
  mp 拖拽段  == mm[1:-2]       (去掉首条与末两条)
  mm[-1]     = post-release    (dx≈40, dy≈59, dt=17ms)
  fi         = focus/blur 与 mc 各点击时间对齐
  ks         = 键盘事件分布在两次打字区间
"""

import math
import random
import time


def xpos_to_slidepos(gap_x):
    """逆向变速公式：缺口位置 → 滑块拖动距离"""
    return round(-10 + math.sqrt(100 + 280 * gap_x))


def _gen_drag(sx, sy, dist, t0):
    """
    生成滑块拖拽点序列（mm 核心部分，不含 hold 和 post-release）。
    速度曲线: 短暂起步 → 快速拖动 → 逐像素精确逼近
    返回 [(x, y, t), ...]
    """
    pts = [(sx, sy, t0)]

    pause = random.randint(20, 90)
    exp = random.uniform(1.5, 3.0)
    main_dist = round(dist * random.uniform(0.92, 0.97))
    main_dur = random.randint(700, 1400)

    up_prob = random.uniform(0.02, 0.08)
    dn_prob = random.uniform(0.01, 0.06)
    cur_y = sy
    last_x = sx

    cur_t = t0 + pause
    elapsed = 0

    while elapsed <= main_dur:
        frac = min(elapsed / main_dur, 1.0)
        eased = 1 - (1 - frac) ** exp
        x = sx + round(eased * main_dist)

        r = random.random()
        if r < up_prob:
            cur_y += 1
        elif r < up_prob + dn_prob:
            cur_y -= 1

        if x != last_x or random.random() > 0.5:
            pts.append((x, cur_y, cur_t))
            last_x = x

        dt = random.randint(6, 10)
        cur_t += dt
        elapsed += dt

    if last_x < sx + main_dist:
        pts.append((sx + main_dist, cur_y, cur_t))
        last_x = sx + main_dist
        cur_t += random.randint(6, 10)

    remaining = max(0, sx + dist - last_x)
    for i in range(remaining):
        dt = random.randint(15, 60) if i < remaining // 2 else random.randint(30, 200)
        cur_t += dt
        last_x += 1
        if random.random() < 0.05:
            cur_y += random.choice([-1, 1])
        pts.append((last_x, cur_y, cur_t))

    if pts[-1][0] != sx + dist:
        cur_t += random.randint(20, 60)
        pts.append((sx + dist, cur_y, cur_t))

    return pts


def _gen_approach(sx, sy, ex, ey, t0, t1, min_n=6):
    """生成两点间的 ease-out 趋近路径"""
    dur = max(100, t1 - t0)
    n = min(max(min_n, dur // random.randint(8, 16)), 50)
    pts = []
    for i in range(n):
        f = i / max(1, n - 1)
        e = 1 - (1 - f) ** 2
        x = round(sx + (ex - sx) * e + random.gauss(0, 0.8))
        y = round(sy + (ey - sy) * e + random.gauss(0, 0.8))
        pts.append((x, y, t0 + round(f * dur)))
    return pts


def _gen_ks(t1s, t1e, t2s, t2e):
    """生成键盘事件（keydown/keyup 配对，格式 "t, ,1"）"""
    evts = []
    for a, b in [(t1s, t1e), (t2s, t2e)]:
        if a >= b:
            continue
        for t in sorted(random.randint(a, b) for _ in range(random.randint(3, 5))):
            evts.append(t)
            evts.append(t + random.randint(0, 4))
    evts.sort()
    return "|".join(f"{t}, ,1" for t in evts)


def _gen_fi(t1d, t2d, t3d, t3u):
    """生成焦点事件（focus=1 / blur=0，与点击时间严格对齐）"""
    b1 = t2d + random.randint(0, 1)
    b2 = t3d + random.randint(0, 1)
    return "|".join([
        f"{t1d + random.randint(1, 8)},1,1",
        f"{b1},0,1", f"{b1 + 1},1,1",
        f"{b2},0,1", f"{b2 + 1},1,1",
        f"{t3u + random.randint(0, 5)},0,1",
    ])


def generate_trajectory(xPos):
    """
    输入缺口位置 xPos，生成完整 TrackList 轨迹。

    返回:
        dict  结构与实际 VerifyCaptchaV3 请求 payload 一致
    """
    slidePos = xpos_to_slidepos(xPos)
    now = int(time.time() * 1000)

    fps = random.uniform(57, 72)
    si = f"342,1280,588,342,588,672,720,{fps},1280"

    # ---------- 4 组点击坐标（真实样本统计区间） ----------
    c1x, c1y = random.randint(100, 200), random.randint(256, 285)   # 用户名输入框
    c2x, c2y = random.randint(135, 190), random.randint(350, 385)   # 密码输入框
    c3x, c3y = random.randint(145, 195), random.randint(430, 455)   # 登录按钮
    slx, sly = random.randint(36, 45), random.randint(382, 391)     # 滑块按钮

    # ---------- 时间线（相对 startTime 的偏移 ms） ----------
    t1d = random.randint(500, 2000)
    t1u = t1d + random.randint(60, 120)

    ks1s = t1u + random.randint(200, 600)
    ks1e = ks1s + random.randint(400, 1500)

    t2d = ks1e + random.randint(200, 800)
    t2u = t2d + random.randint(60, 120)

    ks2s = t2u + random.randint(200, 500)
    ks2e = ks2s + random.randint(400, 1200)

    t3d = ks2e + random.randint(200, 600)
    t3u = t3d + random.randint(40, 100)

    t4d = t3u + random.randint(800, 2000)

    # ---------- 拖拽轨迹 ----------
    drag = _gen_drag(slx, sly, slidePos, t4d)

    last_drag = drag[-1]
    t4u = last_drag[2] + random.randint(200, 800)      # mouseup 时间
    end_x = slx + slidePos
    end_y = last_drag[1]

    # mm = 拖拽点 + 停留（held）+ 释放后甩出（post-release）
    mm_pts = list(drag)
    mm_pts.append((end_x, end_y, t4u))                  # held: 与 mu[3] 完全一致
    mm_pts.append((                                      # post-release: dx≈40 dy≈59 dt=17
        end_x + random.randint(35, 50),
        end_y + random.randint(55, 70),
        t4u + 17,
    ))

    # ---------- mp = 趋近路径 + 拖拽路径 ----------
    mp_pts = []

    # ① 趋近用户名输入框
    ox, oy = random.randint(300, 340), random.randint(290, 360)
    mp_pts += _gen_approach(ox, oy, c1x, c1y,
                            random.randint(50, 300),
                            t1d - random.randint(80, 200))
    mp_pts.append((c1x, c1y, t1d + random.randint(20, 80)))

    # ② 趋近密码输入框
    mp_pts += _gen_approach(c1x + random.randint(-3, 3),
                            c1y + random.randint(-2, 2),
                            c2x, c2y,
                            ks1e - random.randint(200, 500),
                            t2d - random.randint(30, 100))
    mp_pts.append((c2x, c2y, t2d + random.randint(10, 40)))

    # ③ 趋近登录按钮
    mp_pts += _gen_approach(c2x + random.randint(-2, 2),
                            c2y + random.randint(-2, 2),
                            c3x, c3y,
                            ks2e - random.randint(100, 300),
                            t3d - random.randint(20, 60))
    mp_pts.append((c3x, c3y, t3d + random.randint(10, 30)))

    # ④ 验证码出现后，先看图再趋近滑块
    cx, cy = random.randint(280, 340), random.randint(300, 380)
    tc = t3u + random.randint(100, 400)
    mp_pts += _gen_approach(c3x, c3y, cx, cy,
                            t3u + random.randint(30, 80), tc)
    mp_pts += _gen_approach(cx, cy, slx, sly,
                            tc + random.randint(100, 500),
                            t4d - random.randint(30, 100))
    mp_pts.append((slx, sly, t4d - random.randint(10, 40)))

    # ⑤ 拖拽段 = drag[1:]（不含 mm[0] mousedown 点）
    mp_pts += drag[1:]

    # 按时间排序 + 去重
    mp_pts.sort(key=lambda p: p[2])
    clean = [mp_pts[0]]
    for p in mp_pts[1:]:
        if p[2] > clean[-1][2]:
            clean.append(p)
    mp_pts = clean

    # ---------- 格式化输出 ----------
    mc = "|".join([
        f"{c1x},{c1y},{t1d}, ,1",
        f"{c2x},{c2y},{t2d}, ,1",
        f"{c3x},{c3y},{t3d}, ,1",
        f"{slx},{sly},{t4d}, ,1",
    ])
    mu = "|".join([
        f"{c1x},{c1y},{t1u}, ,1",
        f"{c2x},{c2y},{t2u}, ,1",
        f"{c3x},{c3y},{t3u}, ,1",
        f"{end_x},{end_y},{t4u}, ,1",
    ])
    mm = "|".join(f"{p[0]},{p[1]},{p[2]},1" for p in mm_pts)
    mp = "|".join(f"{p[0]},{p[1]},{p[2]},1" for p in mp_pts)
    ks = _gen_ks(ks1s, ks1e, ks2s, ks2e)
    fi = _gen_fi(t1d, t2d, t3d, t3u)

    vt = now + t4u + random.randint(50, 300)

    return {
        "TrackList": {
            "mc": mc, "tc": "", "mu": mu, "te": "",
            "mp": mp, "tmv": "", "mm": mm,
            "ks": ks, "fi": fi,
            "startTime": now, "si": si,
        },
        "TrackStartTime": now,
        "VerifyTime": vt,
        "xPos": str(xPos),
        "slidePos": str(slidePos),
    }


# ===================== 验证 =====================
# if __name__ == "__main__":
#     import json
    #
    # for test_xpos in [176, 195, 200, 230, 247]:
    #     r = generate_trajectory(test_xpos)
    #     tl = r["TrackList"]
    #
    #     mc_last = tl["mc"].split("|")[3].split(",")
    #     mu_last = tl["mu"].split("|")[3].split(",")
    #     mm_arr = tl["mm"].split("|")
    #     mm0 = mm_arr[0].split(",")
    #     mm_held = mm_arr[-2].split(",")
    #     mm_post = mm_arr[-1].split(",")
    #
    #     mc4x = int(mc_last[0])
    #     mu4x = int(mu_last[0].strip())
    #     mu4y = int(mu_last[1])
    #     mu4t = int(mu_last[2].strip())
    #     h_x, h_y, h_t = int(mm_held[0]), int(mm_held[1]), int(mm_held[2])
    #     sp = int(r["slidePos"])
    #
    #     checks = [
    #         ("mc[3].xy == mm[0].xy",
    #          mc4x == int(mm0[0]) and int(mc_last[1]) == int(mm0[1])),
    #         ("mu[3] == mm[-2] (xyz)",
    #          mu4x == h_x and mu4y == h_y and mu4t == h_t),
    #         (f"mu4x-mc4x={mu4x - mc4x} == slidePos={sp}",
    #          mu4x - mc4x == sp),
    #         (f"mm held.x-mm0.x={h_x - int(mm0[0])} == slidePos",
    #          h_x - int(mm0[0]) == sp),
    #         (f"post dt={int(mm_post[2]) - h_t}",
    #          int(mm_post[2]) - h_t == 17),
    #     ]
    #
    #     ok = all(c[1] for c in checks)
    #     status = "PASS" if ok else "FAIL"
    #     print(f"xPos={test_xpos:3d}  slidePos={sp:3d}  "
    #           f"mm_pts={len(mm_arr):3d}  mp_pts={len(tl['mp'].split('|')):3d}  "
    #           f"drag_dur={h_t - int(mm0[2]):5d}ms  {status}")
    #     if not ok:
    #         for name, passed in checks:
    #             if not passed:
    #                 print(f"    FAIL: {name}")
    #
    # print("\n--- 完整 JSON 示例 (xPos=200) ---")
    # sample = generate_trajectory(200)
    # print(json.dumps(sample, indent=2, ensure_ascii=False))
