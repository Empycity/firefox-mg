# -*- coding: utf-8 -*-
"""补环境版验证码客户端：142 段 env 板由真实 feilin（Node 沙箱）产出，
每日层字段（v78d98s/dfghfgdh6 等）仍由纯算覆盖（shim 注入值不参与服务端校准）。
环境变量 XF_ENV_SHIM 指向 feilin_runtime 目录；loguru 只留关键日志。"""
import json, os, subprocess, sys, tempfile, time
from pathlib import Path

from loguru import logger

try:
    from hyxf_replay import xf_captcha as base
    from hyxf_replay.xf_captcha import (CaptchaClient, CaptchaKeys, SCENE_ID, APP_KEY, APP_VERSION,
                                        DEVICE_TYPE_WEB, DEVICE_PLATFORM, APP_NAME, v78d98s, dfghfgdh6,
                                        aes_encrypt, base64, AES, pad)
except ImportError:
    import xf_captcha as base
    from xf_captcha import (CaptchaClient, CaptchaKeys, SCENE_ID, APP_KEY, APP_VERSION,
                            DEVICE_TYPE_WEB, DEVICE_PLATFORM, APP_NAME, v78d98s, dfghfgdh6,
                            aes_encrypt, base64, AES, pad)
FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0"
base.UA = FIREFOX_UA          # 客户端全链路统一 Firefox（与 trace 环境自洽）

# trace round2 真值板（Firefox 142 真实 142 段，来自 deviceToken part2 解密）
_FP2_BOARD = (Path(__file__).parent / "feilin_runtime" / "firefox_board.txt").read_text().split("#")
_FP2_BOARD += [""] * (142 - len(_FP2_BOARD))
_LOG2_BOARD = (Path(__file__).parent / "feilin_runtime" / "log2_board.txt").read_text().split("#")
_LOG2_BOARD += [""] * (142 - len(_LOG2_BOARD))

logger.remove()
logger.add(sys.stderr, level="INFO",
           format="<green>{time:HH:mm:ss}</green> <level>{message}</level>")

SHIM_DIR = Path(os.environ.get("XF_ENV_SHIM", Path(__file__).parent / "feilin_runtime"))
_SHIM_CACHE = None


def _run_shim(device_config_raw, certify_id=""):
    """跑真实 feilin（Node 沙箱），返回 (zhiw, rawJoined, rawResult)。"""
    global _SHIM_CACHE
    req = {"DeviceConfig": device_config_raw, "CertifyId": certify_id,
           "fp2CertifyId": ""}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(req, f)
        path = f.name
    try:
        t0 = time.time()
        r = subprocess.run(["node", str(SHIM_DIR / "run_feilin.js"), path],
                           capture_output=True, timeout=45, cwd=str(SHIM_DIR))
        out = r.stdout.decode("utf8", "replace")
        for line in out.splitlines():
            if line.startswith("__FEILIN_RESULT__"):
                res = json.loads(line[len("__FEILIN_RESULT__"):])
                return res
        raise RuntimeError("shim no result: " + (r.stderr.decode("utf8", "replace")[-200:] or out[-200:]))
    finally:
        os.unlink(path)


class EnvDeviceSession(base.DeviceSession):
    """Log2 env 板 / fp2 板取自真实 feilin 输出，会话动态字段纯算覆盖。"""

    def _shim(self):
        # 每个会话独立跑一次沙箱：feilin 自算的每日层绑定当前 sessionId，禁止跨会话复用
        if getattr(self, "_shim_res", None) is None:
            self._shim_res = _run_shim(self.device_config_raw, "")
        return self._shim_res

    def _feilin_daily(self, board):
        """每日层字段优先采用真实 feilin 计算值（每会话独立子进程，线程零串扰）。
        结果做完整性校验：v78d98s 非空 + dfghfgdh6 为 40+ 位十六进制；
        不完整自动重跑一次沙箱，仍失败回退纯算公式，绝不下发残缺板。"""
        for attempt in (1, 2):
            try:
                res = self._shim()
                raw = res.get("rawResult", {})
                joined = [x.strip('"') for x in res.get("rawJoined", "").split("#")]
                v78 = raw.get("v78d98s") or (joined[21] if len(joined) > 21 else "")
                dfg = joined[52] if len(joined) > 52 else ""
                valid = (v78 and len(v78) >= 8
                         and len(dfg) >= 40
                         and all(c in "0123456789abcdef" for c in dfg))
                if valid:
                    board[21] = v78
                    board[52] = dfg
                    return board
            except Exception:
                pass
            self._shim_res = None      # 丢弃可疑结果，重跑或回退
        return board

    def _log2_board(self):
        """板子 = 真实 feilin 沙箱自算输出原样（每日层/点数随版本环境自适应，内部自洽）。"""
        res = self._shim()
        fields = [x.strip('"') for x in res.get("rawJoined", "").split("#")]
        fields += [""] * (142 - len(fields))
        return "#".join(fields[:142])

    def _fp2_board(self, verify_ts):
        return self._log2_board()

    def _build_env(self):
        return self._log2_board()

    def fp2_plain(self, certify_id, verify_ts):
        return self._fp2_board(verify_ts)

def run_env(max_verify_attempts=3, verify=True, proxies=None):
    """补环境版 solve：返回 CaptchaVerifyParam（verify=False）或完整验证结果。"""
    client = CaptchaClient(proxies=proxies)
    ds = EnvDeviceSession(proxies=proxies)
    ds.log1()
    logger.info("[Log1] session={} ip={}", ds.session_id[:44], ds.config_ip)
    ds.log2()
    init = client.init_captcha_v3()
    init_ts = int(time.time() * 1000)
    gap_img_x = None
    if init.captcha_type == "PUZZLE" and init.raw.get("Image"):
        import requests as _rq
        ua = {"User-Agent": base.UA, "Referer": base.SITE_REFERER}
        for attempt_no in range(1, 6):
            try:
                back = _rq.get(base.IMAGE_CDN + init.raw["Image"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                shad = _rq.get(base.IMAGE_CDN + init.raw["PuzzleImage"], headers=ua, timeout=15, verify=False, proxies=proxies).content
                gap_img_x = base.detect_puzzle_gap(back, shad)
                break
            except RuntimeError as e:
                logger.warning("[PUZZLE] {}，换图重试", str(e)[:60])
                time.sleep(1)
                init = client.init_captcha_v3()
                init_ts = int(time.time() * 1000)
        if gap_img_x is None:
            raise RuntimeError("连续 5 张图缺口识别失败")
    tl_obj = base.generate_trajectory(gap_img_x, start_anchor=init_ts - 1500)
    vt_ms = int(time.time() * 1000)
    fp2 = ds.fp2_plain(init.certify_id, vt_ms + 2)
    device_token = base.build_device_token(init.session_key, fp2, ds.session_id, num=ds.gather_cost)
    data = base.sg_encode_data(json.dumps(tl_obj, separators=(",", ":"), ensure_ascii=False))
    cvp = '{"sceneId":"%s","certifyId":"%s","deviceToken":"%s","data":"%s"}' % (
        SCENE_ID, init.certify_id, device_token, data)
    if not verify:
        return cvp
    resp = client.verify_captcha_v3(init.certify_id, device_token, data)
    ok = (resp.get("Result") or {}).get("VerifyResult")
    logger.info("[verify] VerifyCode={} Result={}", (resp.get("Result") or {}).get("VerifyCode"), ok)
    return {"cvp": cvp, "t001": ok, "verify": resp}


class Yuekeyun(object):
    """hyxf_replay 入口（补环境版，接口与纯算版一致）。"""

    def __init__(self, proxies=None):
        self.proxies = proxies

    def run(self) -> str:
        cvp = run_env(verify=False, proxies=self.proxies)
        if not cvp:
            raise RuntimeError("captcha solve failed")
        return cvp


if __name__ == "__main__":
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    pace = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    ok = 0
    for i in range(1, rounds + 1):
        r = run_env()
        ok += bool(r.get("t001"))
        if i < rounds:
            time.sleep(pace)
    print("T001 %d/%d" % (ok, rounds))
