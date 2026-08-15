import re
import zlib
from urllib.parse import quote
import hmac
import hashlib,json
import base64
import random,time,sys
import uuid
import PIL,cv2
from datetime import datetime, timezone
from loguru import logger
from Crypto.Cipher import AES
import subprocess
import os
import numpy as np
from pathlib import Path
from curl_cffi import requests
from track import generate_trajectory
from captcha_recognizer.recognizer import Recognizer
import threading

BASE_DIR = Path(__file__).resolve().parent
feilin_lock = threading.Lock()
recognizer_lock = threading.Lock()
recognizer = Recognizer()
staticPath_key = {
            "3.23.0/sg.050.8d97ad83a8636f23": "6dayfg2n4o2z0je4",
            "3.23.0/sg.051.588ff088c46a6ff5": "u3gna20rpue4v7kr",
            "3.23.0/sg.052.f3af2127e378b989": "4dajbn9hxgwthpba",
            "3.23.0/sg.053.bfb22ff6476c2a5c": "d9g59av26m05zoyh",
            "3.23.0/sg.054.746c7b7ff7fd5a4d": "7voqg8r3w42i8cwj",
            "3.23.0/sg.055.7b25c8c16c9e35b7": "lqpaivxit5ssr3up",
            "3.23.0/sg.056.9b3b9709c40270a5": "4zhzpogf2hxhl0yl",
            "3.23.0/sg.057.b65794916cd4b4ca": "9tsfgb3f0u7rbvs6",
            "3.23.0/sg.058.b3e8de19c343b108": "1o5ifgfsi9cc2dm8",
            "3.23.0/sg.059.b996214227d17635": "no4z2ewifjtllhvd",
            "3.23.0/sg.060.58c33dba2e0ef1f2": "6ynu7uik296ubdiu",
            "3.23.0/sg.061.389861ce2c2e6b22": "hsvky4rjawgc90ru",
            "3.23.0/sg.062.d7bb817900f3b312": "axf3x4g218whghcx",
            "3.23.0/sg.063.b6347a270ae8a379": "dvwbopvzsyta63n6",
            "3.23.0/sg.064.5c5224d87b38704e": "6umdhpvoq1ty4icl",
            "3.23.0/sg.065.b422e9a048d8584b": "uzu9c19quu7nlxi2",
            "3.23.0/sg.066.0e821538aecf285b": "95wl14uwvlel11i9",
            "3.23.0/sg.067.7f94bf3e27c4b581": "o2b2bp09m7b4m4oh",
            "3.23.0/sg.068.4d0e8d15922c796e": "7skhhcirscw7dvqi",
            "3.23.0/sg.069.b4d0bcbfbe34930a": "2n6n5cgvcao7izuv",
            "3.23.0/sg.070.6aeb2aaec41c1697": "c5hx4v1ql8w6m6o8",
            "3.23.0/sg.071.9f24f3bbddc229b9": "zkumfzpjhx9tyj5l",
            "3.23.0/sg.072.916bcc41216ebc83": "x2eun8na0ighn123",
            "3.23.0/sg.073.0f85021a309fe9f4": "zkumfzpjhx9tyj5l",
            "3.23.0/sg.074.b82cdbd18052c972": "4p5ah1jq302w9xyp",
            "3.23.0/sg.075.80b1c6a6a994aaf5": "u3d8q1aax6jy2drw",
            "3.23.0/sg.076.f39e1caf2adbb1ff": "ww7bit7x80hh9kix",
            "3.23.0/sg.077.7cb2a887da10cce6": "m0wc95h5k2b9x736",
            "3.23.0/sg.078.c9c9cef86de9bdc6": "7ne2c7zv6f67w3su",
            "3.23.0/sg.079.3199fa69d84dbc51": "4jravvaqxfyalll1",
            "3.23.0/sg.080.28276ceb74124d9f": "9wy6b50d286nliy5",
            "3.23.0/sg.081.543041c152114fd2": "9x0aziqmlf8iyq5j",
            "3.23.0/sg.082.29680c1d20fa48cf": "14f8s9yuuu0ovhab",
            "3.23.0/sg.083.f998ebbcc0e45325": "4w7w7krhuostwtdl",
            "3.23.0/sg.084.68186c80d710098a": "d8eripr6yfhwbjyu",
            "3.23.0/sg.085.9d25946d3724e35d": "kwpyc838etkn6izz",
            "3.23.0/sg.086.02c8614567874489": "8d16ah6xtp97x46r",
            "3.23.0/sg.087.e3bee2caa5d838ed": "32v4k4seejpmnzd5",
            "3.23.0/sg.088.e5f3d4c825ad9984": "baqnblucvzyda8vr",
            "3.23.0/sg.089.fb4eeba99c1a4397": "jo7idp8rql0l5dg7",
            "3.23.0/sg.090.b46426708821a045": "qqivp7ys6b68zlmw",
            "3.23.0/sg.091.4c0487711dbb2a74": "o4rfdaav2kv0mcqf",
            "3.23.0/sg.092.3bbcdac60116fa5b": "hskk1g761fgaeiw6",
            "3.23.0/sg.093.66365d0d7b0eab58": "kbft2uq8bsqch1x9",
            "3.23.0/sg.094.363a89c83d5f3423": "j5n8395jv3970vpp",
            "3.23.0/sg.095.4891227c905a6cc8": "899iw8hfxygnvjqe",
            "3.23.0/sg.096.485ecdc9a23bdad5": "er8iygnq70ecgf4h",
            "3.23.0/sg.097.3991bb6da933c921": "ywpz8imcc57zir3r",
            "3.23.0/sg.098.d5c9b14fc70f97c1": "tcbgzrafuuo3a3jq",
            "3.23.0/sg.099.eee10bcf461f4991": "fceclpbjxmd5y8b7",
            "3.24.0/sg.000.36e38e9565ef809a": "mxoop96agph6pigv",
            "3.24.0/sg.001.549aec78d8ae55aa": "1nnan3anxjvlirwr",
            "3.24.0/sg.002.77a043fa85eca71c": "16ly0jcsr8cqq5tv",
            "3.24.0/sg.003.66c14d5cc2c24952": "yn9kinfdycj70zui",
            "3.24.0/sg.004.f61f9f962f0f7273": "k708w0kzugx0d3ml",
            "3.24.0/sg.005.ebf95f87b4eb41fa": "3emguow9m11o3b97",
            "3.24.0/sg.006.1b457e7841e7ce5e": "21k65qiy7u4ts0me",
            "3.24.0/sg.007.3c1a3eb346564e00": "3dez9ymd2p5u1hqa",
            "3.24.0/sg.008.51e54b45d3677ab5": "zm7toya8jhi48xmv",
            "3.24.0/sg.009.36136860e1d3064b": "5yfileec0zcs1woj",
            "3.24.0/sg.010.4bd18dd179b88421": "1hskxi9jj0v1lt4o",
            "3.24.0/sg.011.5598ce9bd2346090": "4modba36e0mhutjh",
            "3.24.0/sg.012.68c1b5b561fdedab": "jd97nnxhpftn6csn",
            "3.24.0/sg.013.c23d3162f31ec5ee": "51niw844i093fbns",
            "3.24.0/sg.014.cc865c3ef0495f69": "sgkedapwr7venwd5",
            "3.24.0/sg.015.7727eb0530961d40": "zh1xhokaezf23azz",
            "3.24.0/sg.016.1bfd8685f82b0039": "ex3664vkzkspt59t",
            "3.24.0/sg.017.15c2ee0bdafbdd79": "b5ekdf9ntwoeqdlx",
            "3.24.0/sg.018.053b73bba86ad89e": "v9y3za9g4ab8e11n",
            "3.24.0/sg.019.ef8991c195ad4201": "xht8lun0aj7zuba7",
            "3.24.0/sg.020.154237263706171b": "o98eba3ae1ql2rul",
            "3.24.0/sg.021.5555b030233802c6": "7qcpj7vbqt392ku4",
            "3.24.0/sg.022.e51ca996ad6d8454": "epv5mvgnp4wcrkrk",
            "3.24.0/sg.023.217b19d28d91a438": "29wmcvjgkw56rfqs",
            "3.24.0/sg.024.ca6769f0ab2a52b7": "qrkccao58a13j1a0",
            "3.24.0/sg.025.7220ed7643a1b92e": "q9wicds82e3jvtza",
            "3.24.0/sg.026.11d8fdf69df8ec62": "emsywmtij1hmk4yt",
            "3.24.0/sg.027.8cc1efa50d17675c": "2575hc44vwt58kjb",
            "3.24.0/sg.028.9f34f6f86167b37d": "vbgtze5ey1urrvmp",
            "3.24.0/sg.029.a972204214b0d3b6": "bk8p1elh9ck3xs0y",
            "3.24.0/sg.030.ea13cff0e71941f7": "77v35fhx1urodkzr",
            "3.24.0/sg.031.71780e5904001ed9": "xqp9shtmrlwz6t1v",
            "3.24.0/sg.032.af08c9a0110f648f": "x70qq74t57tslniw",
            "3.24.0/sg.033.257ad09b4f0eb3a8": "mir2ebq44n9qkb7y",
            "3.24.0/sg.034.47cdb589d4ec6bc5": "eo92xzwqzvvegy03",
            "3.24.0/sg.035.1098d78f264d8ec1": "0p5s9na0745qwdv5",
            "3.24.0/sg.036.9e0338ee3c9cad20": "zdrstq69xo0u07pf",
            "3.24.0/sg.037.c1b2bd7961107f8b": "1cy4nxo547oc1aoa",
            "3.24.0/sg.038.e5204c4cdfc611e7": "hrxso1qwta2veymu",
            "3.24.0/sg.039.cc3563cb2a2d5df0": "disnr7wa7qgxq9vd",
            "3.24.0/sg.040.dd486a4e6d349d55": "54ny0n8wgxuqs7cw",
            "3.24.0/sg.041.90c7bc3c67d7b1d0": "8v0s4mnrnz5imwvm",
            "3.24.0/sg.042.ab42b9b3ed4b8d50": "kow4dybl8zjwkkcr",
            "3.24.0/sg.043.2e19bce7d5eb80dd": "amdubc0eekaowu1e",
            "3.24.0/sg.044.aa74b4ea850d4a76": "oac564ttgs0y7vy4",
            "3.24.0/sg.045.b0bc1171766eb866": "bzhnlpujv3ywgtrz",
            "3.24.0/sg.046.6c1b32128909ec65": "p7qmjejy4llu2avf",
            "3.24.0/sg.047.7cd647ecc6712a2a": "xvuws79t1sxybfap",
            "3.24.0/sg.048.d80ce68c81f51819": "qgegq2bnc0agz2x1",
            "3.24.0/sg.049.dab6246725a0d334": "b1i6y7i6ac60hrs0",
            "3.25.1/sg.000.c9181705069c6e31": "epnfdkm1f3036rzp",
            "3.25.1/sg.001.527f3fb3655d01fd": "calrx3nw15tcbmze",
            "3.25.1/sg.002.df430b9a39144413": "zvg3yk11lxdm8wsa",
            "3.25.1/sg.003.8a2c8b42750cc36c": "kpqif7n2x3h6pdmj",
            "3.25.1/sg.004.3b8b171375c079db": "kae13y3pv1zjvrtu",
            "3.25.1/sg.005.f8475e392d77fa50": "3rzwhhtp6o8jpf7w",
            "3.25.1/sg.006.688a51c0f8283dcf": "y2610b5vg45uszcn",
            "3.25.1/sg.007.197921c9cd0b7c93": "aahf2ai4v76sh72b",
            "3.25.1/sg.008.3144e835a5a82cf7": "qbmr6ljdzj2vfaoe",
            "3.25.1/sg.009.56aa3db34b6ae65c": "a8o0lubemu9lfwmi",
            "3.25.1/sg.010.76051dcf4812f51b": "15wj4ltki92y7qa0",
            "3.25.1/sg.011.f751f00ef0c6476f": "0qu4v5tlnxkcolu7",
            "3.25.1/sg.012.fa0c35c812248de1": "inm9ols1fo6xc4do",
            "3.25.1/sg.013.2d2f290d0a74b0d9": "gvlm77nvlia33cd8",
            "3.25.1/sg.014.74158290d82170eb": "1esvm3gtqr5czkmw",
            "3.25.1/sg.015.fc9c1612d309802d": "a9l71r22jqk11nya",
            "3.25.1/sg.016.9abe0542e819a96f": "hxm72c8g3ubneaxk",
            "3.25.1/sg.017.c8b8cf812a417fff": "xbgbbcb3rrt9jcf5",
            "3.25.1/sg.018.0ad6b1c25c837745": "p0r41w8akc6v4ryu",
            "3.25.1/sg.019.d061b9f492ab828a": "loi1i9ady6hdiagv",
            "3.25.1/sg.020.f137c029fb8fd10d": "uw8ft5xlvrbxsvyg",
            "3.25.1/sg.021.d5d0b72c18c1ab6e": "9014idnxnqs9j82u",
            "3.25.1/sg.022.f84dd08e89ca5ffd": "r6e3m5003nrbrewl",
            "3.25.1/sg.023.a31a3442e1e61d1b": "0nh7ypsrafydh30w",
            "3.25.1/sg.024.2c819f5061353634": "voygt6zyczbytba7",
            "3.25.1/sg.025.c0a1a17d83aa527b": "8bylym3pdcry8vxx",
            "3.25.1/sg.026.3a94dac9b17d4d2b": "ffyc3186yrkpds17",
            "3.25.1/sg.027.e3efb15625fafe35": "dfd8v4iuvm5h042w",
            "3.25.1/sg.028.62bf5bae572a48be": "eofnca96vqcma4wt",
            "3.25.1/sg.029.9dcd869ae78a9a93": "t4tebx5r4mkmdb6t",
            "3.25.1/sg.030.6f94d41f524fbb98": "0tu1gv0770woumar",
            "3.25.1/sg.031.cb16a34ee7a9e4c8": "d0as5cfeszbcagod",
            "3.25.1/sg.032.a48884719ea38d51": "ms7bfzf4wqn4a1xv",
            "3.25.1/sg.033.3e8975645270a8ea": "73jqmfnhq6thwz74",
            "3.25.1/sg.034.5fcd9e153a89d191": "sbeimy8dhspc3vae",
            "3.25.1/sg.035.5adb00ac3dfa0527": "t6c9guqzj6xjn71m",
            "3.25.1/sg.036.f918e268aec6f8e8": "ynm4h0ana23tjemv",
            "3.25.1/sg.037.e7db2401c3eb8e62": "m34sgxixyqdd35fa",
            "3.25.1/sg.038.946ec5603be10448": "qtqoftuacmb1r7l6",
            "3.25.1/sg.039.89eb0c373c964925": "8kq1u0yb5i8r23vu",
            "3.25.1/sg.040.7bfc767f6aace194": "3wev2mmkspvpsziy",
            "3.25.1/sg.041.f71ffcc04ab32956": "omr0c9y7ggcq8f72",
            "3.25.1/sg.042.3899e07c5f42471b": "2ad03xdtsnneech7",
            "3.25.1/sg.043.7ba4eaa26e6c107d": "5dtx4ptivtwlv7wd",
            "3.25.1/sg.044.2bc8dfe7127feac9": "z1hvjod6i9va08q0",
            "3.25.1/sg.045.7bf610eb30eaefe6": "0iv5ljpw458sr4q8",
            "3.25.1/sg.046.5a47cc0d7fe89381": "cdczjcmegmuud6k3",
            "3.25.1/sg.047.676ef134a4195762": "nw2jn49rsodnbkk4",
            "3.25.1/sg.048.088a48bd1b514225": "56pjfmyw0h90pyz4",
            "3.25.1/sg.049.f981b6cb147d6202": "17ehojdfy4cfsskx",
}


class Yuekeyun:
    feilinText = None
    devices = None
    certifyId = None
    StaticPath = None
    sId = '1bn1l0rb'
    pfx = '1oa2ns'
    # FeiLin 1.5.1 current browser contract (trace 2026-08-15).
    # This is a protocol/environment version field; the cryptographic
    # and track encoding algorithms remain unchanged.
    update_W = 'W.10054'
    headers = {
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://resource.51xf.cn',
        'Pragma': 'no-cache',
        'Referer': 'https://resource.51xf.cn/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; JiSu) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.3.1.7 Safari/537.36'
    }

    def __init__(self,proxies=None):
        self.sess = requests.Session(impersonate='chrome131')
        self.sess.headers.update(self.headers)
        self.feilinText = ''
        self.image_path = BASE_DIR / f'.captcha-{uuid.uuid4().hex}.png'

        if proxies:
            self.sess.proxies = proxies

    def run_feilin(self):
        node_script_path = str(BASE_DIR / "v2_env.js")
        feilin_context = {**self.devices, "certifyId": self.certifyId or ""}
        node_bin = os.environ.get(
            "ALIV3_NODE",
            str(Path.home() / ".nvm/versions/node/v22.14.0/bin/node"),
        )
        command = [node_bin, node_script_path, json.dumps(feilin_context, separators=(',', ':'))]
        node_env = os.environ.copy()
        node_modules = os.environ.get(
            "ALIV3_NODE_MODULES",
            str(Path.home() / "Desktop/Andriod-MG/node_modules"),
        )
        node_env["NODE_PATH"] = os.pathsep.join(
            value for value in (node_modules, node_env.get("NODE_PATH")) if value
        )

        # 强制加锁：同一时刻只允许一个线程执行 subprocess
        with feilin_lock:
            try:
                # 加上 timeout 防止某个进程卡死导致全部线程死锁
                result = subprocess.check_output(
                    command,
                    text=True,
                    encoding='utf-8',
                    timeout=10,
                    env=node_env,
                    cwd=BASE_DIR,
                ).strip()
                marker = '__FEILIN_RESULT__'
                if marker in result:
                    collected = json.loads(result.rsplit(marker, 1)[1])
                    self.gather_cost = str(collected['gatherCost'])
                    self.feilin_data = collected['zhiw']
                    return self.feilin_data
                return result
            except subprocess.TimeoutExpired:
                print("执行 JS 超时")
                return None
            except Exception as e:
                print(f"执行 JS 失败: {e}")
                return None

    def slide_verify(self):
        with recognizer_lock:
            box, confidence = recognizer.identify_gap(source=str(self.image_path),
                                                      verbose=False)
        try:
            self.image_path.unlink()
        except FileNotFoundError:
            pass
        if not box:
            raise ValueError('captcha recognizer returned no gap')
        mouse_x = box[0]
        return int(mouse_x)

    @staticmethod
    def generate_random_str(length):
        base_str = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
        return ''.join(random.choices(base_str, k=length))

    @staticmethod
    def track_arg(msg, key):
        s = [
            32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30, 60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4,
            61,
            13, 47, 49, 18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40, 8, 57, 45, 35, 59, 36, 42, 54,
            63,
            3, 24, 28, 14, 9, 0, 21
        ]
        n = 0
        key_length = len(key)
        for m in range(len(s)):
            n = (m + n + s[m] + s[n] >> 1) + ord(key[m % key_length]) & (len(s) - 1)
            if m == n: continue
            s[m] = s[m] ^ s[n]
            s[n] = s[m] ^ s[n]
            s[m] = s[m] ^ s[n]
        m, n = 0, 0
        arr = []
        for _ in range(len(msg)):
            n = (m ^ n) + (s[m] ^ s[n]) & len(s) - 1
            if m != n:
                s[m] = s[m] ^ s[n]
                s[n] = s[m] ^ s[n]
                s[m] = s[m] ^ s[n]
                c = ord(msg[_])
                c = c + (m + s[m])
                c = c - (n + s[n])
                c = c ^ s[m] + s[n]
                c = c ^ s[s[m] + s[n] & len(s) - 1]
                c = c & 255
                m = m + 1 & len(s) - 1
            else:
                c = ord(msg[_])
                c = c + (m + s[m])
                c = c - (n + s[n])
                c = c ^ s[m] + s[n]
                c = c ^ s[s[m] + s[n] & len(s) - 1]
                c = c & 255
                m = m + 1 & len(s) - 1
            arr.append(c)
        return base64.standard_b64encode(bytes(arr)).decode()

    @staticmethod
    def get_track_sign(msg, _pad):
        il = len(msg)
        kl = len(_pad)
        s = [(a << 4) + a % 16 for a in range(16)]
        sl = len(s)
        b = 0
        for a in range(sl):
            b = (a + b + s[a] + s[b] >> 1) + ord(_pad[a % kl]) & sl - 1
            s[a], s[b] = s[b], s[a]
        a = b = 0
        for v in range(il):
            b = (a ^ b) + (s[a] ^ s[b]) & (sl - 1)
            s[a], s[b] = s[b], s[a]
            t = (ord(msg[v]) + (a + b)) ^ (s[a] ^ s[b]) & 255
            s[a] = t
            a = a + 1 & sl - 1
        for a in range(sl << 1):
            b = a % sl
            if b:
                s[b] ^= s[b - 1]
            else:
                s[b] ^= s[sl - 1]
        return ''.join(f"{x:02x}" for x in s)

    # Aes解密
    def aesDecrypt(self,data,key=None,iv=None):
        BLOCK_SIZE = 16  # Bytes
        pad = lambda s: s + (BLOCK_SIZE - len(s) % BLOCK_SIZE) * \
                        chr(BLOCK_SIZE - len(s) % BLOCK_SIZE)
        unpad = lambda s: s[:-ord(s[len(s) - 1:])]
        '''
        :param key: 密钥
        :param data: 加密后的数据（密文）
        :return:明文
        '''
        if key == None or iv == None:
            iv = '98d71fe589499967'
            key = '7fb498553e3c462988c3b9573692bd5f'

        data = base64.b64decode(data)
        cipher = AES.new(key.encode('utf8'), AES.MODE_CBC,iv.encode('utf8'))

        # 去补位
        text_decrypted = unpad(cipher.decrypt(data))
        text_decrypted = text_decrypted.decode('utf8')

        return text_decrypted

    # Aes加密
    def aesEncrypt(self,text,key=None,iv=None):
        if key == None or iv == None:
            iv = '98d71fe589499967'
            key = '7fb498553e3c462988c3b9573692bd5f'

        cipher = AES.new(key.encode('utf-8'), AES.MODE_CBC, iv.encode('utf-8'))
        pad = 16 - len(text) % 16
        text = text + pad * chr(pad)
        encrypted_text = cipher.encrypt(text.encode('utf-8'))
        return base64.b64encode(encrypted_text).decode('utf-8')

    def getTimeNum(self):
        utc_now = datetime.utcnow().replace(tzinfo=timezone.utc)
        year = str(utc_now.year)
        month = '0' + str(utc_now.month) if utc_now.month < 10 else str(utc_now.month)
        day = '0' + str(utc_now.day) if utc_now.day < 10 else str(utc_now.day)
        hour = '0' + str(utc_now.hour) if utc_now.hour < 10 else str(utc_now.hour)
        minute = '0' + str(utc_now.minute) if utc_now.minute < 10 else str(utc_now.minute)
        second = '0' + str(utc_now.second) if utc_now.second < 10 else str(utc_now.second)
        return year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':' + second + 'Z'

    def get_Signature(self,data,key):
        key = key + '&'
        datas = {key:quote(data[key]).replace('/','%2F') for key in sorted(data)}
        dataStr = "POST&%2F&" + quote('&'.join([key + '=' + val for key,val in datas.items()]))
        hmac_obj = hmac.new(key.encode(),dataStr.encode(),hashlib.sha1).digest()
        Signature = base64.b64encode(hmac_obj).decode()
        return Signature

    def aliyuncs_cofig_init(self):
        data = {
            'AccessKeyId': 'LTAI5tGjnK9uu9GbT9GQw72p',
            'Version': '2020-10-15',
            'SignatureMethod': 'HMAC-SHA1',
            'SignatureVersion': '1.0',
            'Format': 'JSON',
            'Action': 'Log1',
            'Data': 'byAgDBTTWK6iQ63aLnMRvywYbJ50c453wUz9CdNf4pWB+H4EOu7koqzwbASi1Zy3zgHU8sTKNHpOkNOGqQFYFnvWEtqbKW2d+VVGKvdqNm1ZYMogd5vlHCQE340CuLjqQDcRcBZCbmqmtGoUXOa4w1W0wwhd5rIiFnw/eskOKxI=',
            'SignatureNonce': f'{uuid.uuid4()}',
            # 'Signature': '0kzezAFGHY8HLq5/3rNFZr2oecQ=',
        }
        data['Signature'] = self.get_Signature(data,key='fpOKzILEajkqgSpr9VvU98FwAgIRcX')

        response = self.sess.post('https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/', data=data)

        # logger.success(f'初始化接口：{response.json()}')

        # 设备配置信息  --- 解密
        DeviceConfig = response.json()['ResultObject']['DeviceConfig']
        deviceConfigInfo = self.aesDecrypt(DeviceConfig,'87f879f135f27da7','0123456789ABCDEF').split('#')
        self.deviceConfigInfo = deviceConfigInfo
        devices = {
            'key':base64.b64decode(deviceConfigInfo[0]).decode(),
            'switch':int(base64.b64decode(deviceConfigInfo[1]).decode()),
            'sessionId':deviceConfigInfo[2],
            'version':deviceConfigInfo[3],
            "pluginElements": "",
            "pluginResource": "",
            "globalVariable": "",
            'timestamp':deviceConfigInfo[7],
            'ip':deviceConfigInfo[8],
        }
        # logger.success(f'设备配置信息：{devices}')
        self.devices = devices
        feilin_path = BASE_DIR / 'feilin.js'
        expected_sha = deviceConfigInfo[3].rsplit('.', 1)[-1]
        cached = False
        if feilin_path.exists():
            cached = hashlib.sha256(feilin_path.read_bytes()).hexdigest() == expected_sha
        if not cached:
            with feilin_lock:
                if not feilin_path.exists() or hashlib.sha256(feilin_path.read_bytes()).hexdigest() != expected_sha:
                    response = self.sess.get(
                        url='https://g.alicdn.com/captcha-frontend/FeiLin/' + deviceConfigInfo[3] + '.js')
                    response.raise_for_status()
                    temp_path = feilin_path.with_suffix('.js.tmp')
                    temp_path.write_text(response.text, encoding='utf-8')
                    temp_path.replace(feilin_path)
        self.feilinText = feilin_path.read_text(encoding='utf-8')

    def aliyuncs_CaptchaType_CertifyId(self):

        data = {
            'AccessKeyId': 'LTAI5tSEBwYMwVKAQGpxmvTd',
            'SignatureMethod': 'HMAC-SHA1',
            'SignatureVersion': '1.0',
            'Format': 'JSON',
            'Timestamp': r'{}'.format(self.getTimeNum()),
            'Version': '2023-03-05',
            'Action': 'InitCaptchaV3',
            'SceneId': self.sId,
            'Language': 'cn',
            'Mode': 'embed',
            'SignatureNonce': f'{uuid.uuid4()}',
            # 'Signature': 'ohxRplayojw4LbweTYAaTcL0Sv0=',
        }
        data['Signature'] = self.get_Signature(data,key='YSKfst7GaVkXwZYvVihJsKF9r89koz')
        response = self.sess.post('https://1oa2ns.captcha-open.aliyuncs.com/', data=data)
        # logger.success(f'获取滑块类型及其CertifyId:{response.json()}')

        if response.json()['CaptchaType'] == 'SLIDING' or response.json()['CaptchaType'] == 'CHECK_BOX':
            logger.success(f'阿里v3滑块类型为：{response.json()["CaptchaType"]},CertifyId为：{response.json()["CertifyId"]}')
            self.certifyId = response.json()['CertifyId']
            self.StaticPath = response.json()['StaticPath']

        else:
            logger.warning(f'阿里v3滑块类型为：{response.json()["CaptchaType"]},CertifyId为：{response.json()["CertifyId"]}')
            self.certifyId = response.json()['CertifyId']
            self.StaticPath = response.json()['StaticPath']
            Image ='https://static-captcha.aliyuncs.com/' + response.json()['Image']
            PuzzleImage ='https://static-captcha.aliyuncs.com/' +  response.json()['PuzzleImage']
            headers = {
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Connection": "keep-alive",
                "Sec-Fetch-Dest": "image",
                "Sec-Fetch-Mode": "no-cors",
                "Sec-Fetch-Site": "cross-site",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf254186b) XWEB/11275"
            }
            Image_  = requests.get(Image,headers = headers).content
            with open(self.image_path,'wb') as f:
                f.write(Image_)
            # PuzzleImage_ = requests.get(PuzzleImage,headers = headers).content

            x1 = self.slide_verify()
            self.distance = generate_trajectory(x1)
            # logger.success(f'轨迹：{self.distance}')

    def aliyuncs_verify(self):
        # Reuse the first-round collection so the final token contains the
        # same browser, OS, screen and feature set sent by Log2.
        _zhiw = getattr(self, 'feilin_data', None) or self.run_feilin()
        arg0 = self.aesEncrypt(_zhiw, self.devices['key'], '0123456789ABCDEF')
        device_token_revision = getattr(self, 'gather_cost', None)
        if device_token_revision is None:
            raise RuntimeError('FeiLin collection did not export GatherCost')
        arg1 = hashlib.md5('#'.join(["WEB",self.devices['sessionId'],arg0,device_token_revision,"daye,raolewoba!"]).encode()).hexdigest()
        deviceToken = base64.b64encode('#'.join(["WEB",self.devices['sessionId'],arg0,device_token_revision,arg1]).encode()).decode()

        guiji = self.distance
        guiji["arg"] = "null"
        track_str = json.dumps(guiji,separators=(',' , ':' ))
        track_sign = self.get_track_sign(track_str,"0000")
        gui = track_sign+json.dumps(guiji,separators=(',' , ':' ))
        guiji_zlib = zlib.compress(gui.encode())
        guiji_zlib = base64.b64encode(guiji_zlib).decode()
        Data = self.track_arg(guiji_zlib, "3e627e1b4c63f913")

        data = {
            'AccessKeyId': 'LTAI5tSEBwYMwVKAQGpxmvTd',
            'SignatureMethod': 'HMAC-SHA1',
            'SignatureVersion': '1.0',
            'Format': 'JSON',
            'Timestamp': r'{}'.format(self.getTimeNum()),
            'Version': '2023-03-05',
            'Action': 'VerifyCaptchaV3',
            'SceneId': self.sId,
            'CertifyId': self.certifyId,
            'CaptchaVerifyParam': '{"sceneId":"'+self.sId+'","certifyId":"'+self.certifyId+'","deviceToken":"'+deviceToken+'","data":"'+Data+'"}',
            'SignatureNonce': f'{uuid.uuid4()}',
            # 'Signature': 'fql2Sx9UOXnlKH2z6UoCgkxm8vs=',
        }

        return data['CaptchaVerifyParam']
        # data['Signature'] = self.get_Signature(data,key='YSKfst7GaVkXwZYvVihJsKF9r89koz')
        # response = requests.post('https://1oa2ns.captcha-open.aliyuncs.com/', data=data)
        # # logger.success(f'问卷星阿里VerifyCaptchaV3接口：{response.json()}')
        # if response.json()['Result']['VerifyCode'] == 'T001':
        #     logger.success(f'阿里VerifyCaptchaV3接口验证成功：{response.json()}')
        # else:
        #     logger.error(f'阿里VerifyCaptchaV3接口验证失败：{response.json()}')


    def aliyuncs_log2(self):
        feilin_datas = self.run_feilin()
        arg0 = self.devices['sessionId']

        arg1 = self.aesEncrypt(feilin_datas,self.devices['key'],'0123456789ABCDEF')
        arg2 = self.aesEncrypt('saf-captcha',self.devices['key'],'0123456789ABCDEF')
        arg3 = self.aesEncrypt(f'{self.update_W}',self.devices['key'],'0123456789ABCDEF')
        arg4 = ''
        arg5 = self.aesEncrypt(str(int(time.time() * 1000)),self.devices['key'],'0123456789ABCDEF')
        _zhiw = base64.b64encode(str(f'{arg0}#{arg1}#{arg2}#{arg3}#{arg4}#{arg5}').encode()).decode('utf-8')

        strEncrypt = self.aesEncrypt(f'{self.update_W}#saf-captcha#{self.sId}',self.devices['key'],'0123456789ABCDEF')
        DataStr = f'{self.devices["sessionId"].split("-")[0]}#W#{strEncrypt}#W20220202#CLOUD#421#501#{_zhiw}'
        Data = self.aesEncrypt(DataStr,'a549a55c60a39aa0','0123456789ABCDEF')

        data = {
            'AccessKeyId': 'LTAI5tGjnK9uu9GbT9GQw72p',
            'Version': '2020-10-15',
            'SignatureMethod': 'HMAC-SHA1',
            'SignatureVersion': '1.0',
            'Format': 'JSON',
            'Action': 'Log2',
            'Data': Data,
            'SignatureNonce': f'{uuid.uuid4()}'
            # 'Signature': 'lW1apg9+zWR1wuUe2w2OR0UqB4I=',
        }
        data['Signature'] = self.get_Signature(data,key='fpOKzILEajkqgSpr9VvU98FwAgIRcX')

        response = self.sess.post('https://cloudauth-device-dualstack.cn-shanghai.aliyuncs.com/', data=data)
        # logger.success(f'Log2接口：{response.json()}')


    def run(self):

        try:
            self.aliyuncs_cofig_init()
            self.aliyuncs_CaptchaType_CertifyId()
            self.aliyuncs_log2()
            return self.aliyuncs_verify()
        except Exception as e:
            logger.error(f'错误：{e}')
            return None

if __name__ == '__main__':
    proxies = None
    yuekeyun = Yuekeyun(proxies)
    for i in range(20):
        print(yuekeyun.run())
