# -*- coding: utf-8 -*-
"""track.py —— 阿里 v2 滑块轨迹生成器，与 JS 版 track.js 逐一对应（2026-08-28 移植）

按 2026-08-16 的 10 条人工 T001 轨迹校准（校准区间见各常量注释）：
  - mm（拖动，含按下点 + 释放尾点）：14~19 个点
  - 拖动时长 131~230ms（中位 ~157）；拖动距离 298~407px
  - 首次移动延迟双峰 3~47 / 67~114ms；按下前停顿多为 1~7、偶发 33~137
  - 释放尾点 = 终点 * 1.15，+16/17ms；采样间隔 7~10ms（12% 概率 11~16）
  - mp 只存 mousemove（mc == mm[0]）；verify 在最后一个拖动点后 1~2ms 触发

随机数：JS 版用 mulberry32 变体，传 seed 完全可复现（回归测试用）。
Python 版按位复刻同一算法（含 Math.imul 的 32 位截断语义），同 seed 输出与 JS 逐字节一致。
"""

import math
import time

# 人工 T001 轨迹实测的"按下前停顿"样本池（ms）
T001_PRE_DOWN_IDLE = [1, 1, 1, 2, 4, 5, 7, 33, 36, 137]
# 人工 T001 轨迹实测的"首次移动延迟"样本池（ms，快/慢双峰）
T001_FIRST_MOVE_DELAY = [3, 4, 7, 18, 19, 28, 46, 47, 67, 114]


def _imul32(a, b):
    """Math.imul：32 位截断乘法（位模式与符号无关，后续都做位运算）"""
    return (a & 0xFFFFFFFF) * (b & 0xFFFFFFFF) & 0xFFFFFFFF


class _SeededRandom:
    """mulberry32 变体，位级复刻 JS 实现（含 >>>0 / Math.imul 语义）"""

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def random(self):
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        value = self.state
        value = _imul32(value ^ (value >> 15), value | 1)
        value = value ^ ((value + _imul32(value ^ (value >> 7), value | 61)) & 0xFFFFFFFF)
        return ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296.0


def _js_round(x):
    """Math.round：四舍五入（.5 恒向上），区别于 Python round 的银行家舍入"""
    return math.floor(x + 0.5)


def _js_fixed(x, digits):
    """Number.toFixed：固定小数位（值域 ~60，无 JS/Python 舍入差异场景）"""
    return "%.*f" % (digits, x)


def _ease_in_out_sine(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)


class _Helpers:
    """随机工具集：区间随机数 / 区间整数 / 夹取 / 按权重挑样本"""

    def __init__(self, rng):
        self.rng = rng

    def rand(self, lo, hi):
        return self.rng() * (hi - lo) + lo

    def rand_int(self, lo, hi):
        return _js_round(self.rand(lo, hi))

    def clamp(self, value, lo, hi):
        return max(lo, min(hi, value))

    def pick(self, values):
        return values[int(self.rng() * len(values))]

    def chance(self, probability):
        return self.rand(0, 1) < probability


def _spread_intervals(duration, gap_count, h):
    """duration 毫秒分到 gapCount 个间隔：多数 7~10ms，约 12% 出现 11~16ms，整体缩放到精确总时长"""
    if gap_count <= 0:
        return []
    intervals = []
    used = 0
    for _ in range(gap_count):
        gap = h.rand_int(7, 10)
        if h.chance(0.12):
            gap = h.rand_int(11, 16)
        intervals.append(gap)
        used += gap
    scale = duration / (used or 1)
    total = 0
    for i in range(len(intervals)):
        intervals[i] = max(1, _js_round(intervals[i] * scale))
        total += intervals[i]
    difference = duration - total
    guard = 0
    while difference != 0 and guard < 10000:
        guard += 1
        index = h.rand_int(0, len(intervals) - 1)
        if difference > 0:
            intervals[index] += 1
            difference -= 1
        elif intervals[index] > 1:
            intervals[index] -= 1
            difference += 1
    return intervals


def _build_drag_points(click, end_point, move_count, h):
    """拖动段移动点（不含 mousedown 采样点）：easeInOutSine 扫到终点，x 单调不减"""
    distance = end_point["x"] - click["x"]
    y_delta = end_point["y"] - click["y"]
    points = []
    previous_x = None
    for i in range(1, move_count + 1):
        progress = i / move_count
        x = _js_round(click["x"] + distance * _ease_in_out_sine(progress) + h.rand(-0.4, 0.4))
        y_trend = _js_round(click["y"] + y_delta * progress + h.rand(-0.8, 0.8))
        if previous_x is not None and x < previous_x:
            x = previous_x
        if i == move_count:
            x = end_point["x"]
        points.append({"x": x, "y": y_trend, "t": 0})
        previous_x = x
    return points


def _build_approach(click, count, duration, viewport, h):
    """接近段：从视口内随机方向起点出发，三次贝塞尔曲线到按钮，末端精确落在按钮上"""
    if count == 1:
        # JS 版此时 u=0/0=NaN，但首尾同点覆盖后等价于直接落在按钮上
        return [{"x": click["x"], "y": click["y"], "t": 0}]
    side = h.rand_int(0, 3)
    if side == 0:
        start = {"x": click["x"] + h.rand_int(120, 420), "y": click["y"] + h.rand_int(60, 260)}
    elif side == 1:
        start = {"x": click["x"] - h.rand_int(120, 380), "y": click["y"] + h.rand_int(80, 300)}
    elif side == 2:
        start = {"x": click["x"] + h.rand_int(-260, 260), "y": click["y"] - h.rand_int(120, 320)}
    else:
        start = {"x": click["x"] + h.rand_int(-200, 200), "y": click["y"] + h.rand_int(180, 380)}
    start["x"] = h.clamp(start["x"], 20, viewport["width"] - 20)
    start["y"] = h.clamp(start["y"], 20, viewport["height"] - 20)

    c1 = {
        "x": start["x"] + (click["x"] - start["x"]) * h.rand(0.2, 0.5) + h.rand(-60, 60),
        "y": start["y"] + (click["y"] - start["y"]) * h.rand(0.1, 0.4) + h.rand(-40, 40),
    }
    c2 = {
        "x": start["x"] + (click["x"] - start["x"]) * h.rand(0.6, 0.9) + h.rand(-40, 40),
        "y": start["y"] + (click["y"] - start["y"]) * h.rand(0.5, 0.9) + h.rand(-25, 25),
    }

    points = []
    intervals = _spread_intervals(duration, count - 1, h)
    time_cursor = 0
    for i in range(count):
        u = i / (count - 1)
        e = _ease_in_out_sine(u)
        inv = 1 - e
        x = inv * inv * inv * start["x"] + 3 * inv * inv * e * c1["x"] + 3 * inv * e * e * c2["x"] + e * e * e * click["x"]
        y = inv * inv * inv * start["y"] + 3 * inv * inv * e * c1["y"] + 3 * inv * e * e * c2["y"] + e * e * e * click["y"]
        x = _js_round(x + h.rand(-0.4, 0.4))
        y = _js_round(y + h.rand(-0.4, 0.4))
        if i == 0:
            x, y = start["x"], start["y"]
        if i == count - 1:
            x, y = click["x"], click["y"]
        points.append({"x": x, "y": y, "t": time_cursor})
        if i < len(intervals):
            time_cursor += intervals[i]
    return points


def _dedupe_exact(points):
    """去除连续完全相同的点（坐标和时间都一样才算重复）"""
    out = []
    for i, point in enumerate(points):
        if i == 0:
            out.append(point)
            continue
        previous = points[i - 1]
        if point["x"] != previous["x"] or point["y"] != previous["y"] or point["t"] != previous["t"]:
            out.append(point)
    return out


def _format_points(points):
    return "|".join("%d,%d,%d,1" % (p["x"], p["y"], p["t"]) for p in points)


def generate_track_list(config=None):
    """轨迹生成主函数（对应 JS generateTrackList）

    config: startTime / si / viewport / seed / clickPoint / endPoint / dragDistance 等
    返回 (track_dict, verify_elapsed)：track_dict 键顺序与 JS 一致（JSON.stringify 依赖插入序），
    verify_elapsed 对应 JS 藏在不可枚举属性的 verifyElapsed。
    """
    config = config or {}
    seed = config.get("seed")
    rng = _SeededRandom(seed).random if seed is not None else _SystemRandom()
    h = _Helpers(rng)
    start_time = config.get("startTime", int(time.time() * 1000))

    viewport = config.get("viewport") or {"width": 1920, "height": 969}

    # 按钮位置：页面内容坐标（与真实 T001 抓包同分布）
    click_point = config.get("clickPoint") or {
        "x": h.rand_int(580, 645),
        "y": h.rand_int(282, 300),
    }
    # 拖动距离 298~407px；y 方向多为向下小漂移（85%），偶发向上
    drag_distance = config.get("dragDistance")
    if drag_distance is None:
        drag_distance = h.rand_int(298, 407)
    drag_y_delta = config.get("dragYOffset")
    if drag_y_delta is None:
        drag_y_delta = h.rand_int(2, 26) if rng() < 0.85 else h.rand_int(-10, 2)
    end_point = config.get("endPoint") or {
        "x": click_point["x"] + drag_distance,
        "y": click_point["y"] + drag_y_delta,
    }

    # --- 拖动时序（全部取自人工 T001 实测分布） ---
    drag_point_count = config.get("dragPointCount")
    if drag_point_count is None:
        drag_point_count = h.rand_int(13, 18)  # mm 点数（含按下点）
    drag_duration = config.get("dragDuration")
    if drag_duration is None:
        drag_duration = h.rand_int(131, 172) if rng() < 0.7 else h.rand_int(173, 230)
    pre_down_idle = config.get("preDownIdle")
    if pre_down_idle is None:
        pre_down_idle = h.pick(T001_PRE_DOWN_IDLE)
    first_move_delay = config.get("firstMoveDelay")
    if first_move_delay is None:
        first_move_delay = h.pick(T001_FIRST_MOVE_DELAY)
    tail_delay = config.get("tailDelay")
    if tail_delay is None:
        tail_delay = 16 if rng() < 0.9 else 17
    verify_delay = config.get("verifyDelay")
    if verify_delay is None:
        verify_delay = h.rand_int(1, 2)

    # --- 接近段：与人工抓包一致的双峰形态 ---
    approach_points_cfg = config.get("approachPoints")
    use_long_approach = approach_points_cfg > 3 if approach_points_cfg is not None else rng() < 0.6

    if use_long_approach:
        # 长接近：60~105 点，0.5~1.5s，前面还有 0~400ms 初始闲置
        approach_points = approach_points_cfg if approach_points_cfg is not None else h.rand_int(60, 105)
        approach_duration = config.get("approachDuration")
        if approach_duration is None:
            approach_duration = h.rand_int(560, 1500)
        initial_idle = config.get("initialIdle")
        if initial_idle is None:
            initial_idle = h.rand_int(0, 400)
    else:
        # 直接型：1~3 个零散点，之前有 1.2~15s 的长闲置（人盯着看）
        approach_points = approach_points_cfg if approach_points_cfg is not None else h.rand_int(1, 3)
        approach_duration = config.get("approachDuration")
        if approach_duration is None:
            approach_duration = h.rand_int(40, 200)
        initial_idle = config.get("initialIdle")
        if initial_idle is None:
            initial_idle = h.rand_int(1200, 15000)

    # 组装接近段并整体平移到 initial_idle 之后
    approach = _build_approach(click_point, approach_points, approach_duration, viewport, h)
    for point in approach:
        point["t"] += initial_idle

    # 组装拖动段：mousedown 点 + 移动点，时间从 clickTime + firstMoveDelay 起分配
    click_time = approach[-1]["t"] + pre_down_idle
    drag = _build_drag_points(click_point, end_point, drag_point_count - 1, h)
    drag.insert(0, {"x": click_point["x"], "y": click_point["y"], "t": 0})  # mousedown 采样点
    move_duration = drag_duration - first_move_delay
    intervals = _spread_intervals(move_duration, drag_point_count - 2, h)
    time_cursor = click_time + first_move_delay
    for i in range(1, len(drag)):
        drag[i]["t"] = time_cursor
        if i - 1 < len(intervals):
            time_cursor += intervals[i - 1]
    # 按住未动阶段 x 保持不变（真实手部停顿的静止特征）
    drag[1] = {"x": click_point["x"], "y": click_point["y"] + (0 if rng() < 0.5 else 1), "t": drag[1]["t"]}

    # 释放尾点：终点 * 1.15（与真实抓包公式一致），+16/17ms
    drag_end = drag[-1]
    tail_point = config.get("tailPoint") or {
        "x": _js_round(drag_end["x"] * 1.15),
        "y": _js_round(drag_end["y"] * 1.15),
    }
    verify_elapsed = drag_end["t"] + verify_delay

    # mp = 接近段 + 拖动移动点（不含 mousedown 点）；mm = mousedown + 移动点 + 尾点
    mp_points = _dedupe_exact(approach + drag[1:])
    mm_points = (
        [{"x": click_point["x"], "y": click_point["y"], "t": click_time}]
        + drag[1:]
        + [{"x": tail_point["x"], "y": tail_point["y"], "t": drag_end["t"] + tail_delay}]
    )

    # si 第 8 位：requestAnimationFrame 实测帧率（由调用方按档案区间传入）
    frame_metric = config.get("frameMetric")
    if frame_metric is None:
        lo, hi = 58.6, 61.4
        frame_metric = _js_fixed(h.rand(lo, hi), 14)
    si = config.get("si") or (
        "1920,1920,%d,1920,%d,1040,1080,%s,1920" % (viewport["height"], viewport["height"], frame_metric)
    )

    track = {
        "mc": "%d,%d,%d, ,1" % (click_point["x"], click_point["y"], click_time),
        "tc": "",
        "mu": "",
        "te": "",
        "mp": _format_points(mp_points),
        "tmv": "",
        "mm": _format_points(mm_points),
        "ks": "",
        "fi": "",
        "startTime": start_time,
        "si": si,
    }
    return track, verify_elapsed


class _SystemRandom:
    """无 seed 时用系统随机（对应 JS 直接用 Math.random）"""

    import random as _random

    def __call__(self):
        return self._random.random()


def get_verify_elapsed(track, verify_elapsed=None):
    """从轨迹对象取 verifyElapsed；退化方案从 mm 最后一个点推（+1ms）"""
    if verify_elapsed is not None:
        return verify_elapsed
    last_move = [s for s in str(track.get("mm") or "").split("|") if s]
    if not last_move:
        raise TypeError("TrackList.mm does not contain a pointer move")
    return int(last_move[-1].split(",")[2]) + 1
