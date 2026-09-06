#!/usr/bin/env python3
"""Run the pure-Node FeiLin verify pipeline concurrently and summarize T001."""
import argparse
import concurrent.futures
import logging
import os
import re
import subprocess
import sys
import time

# Keep direct `python batch_verify.py` invocations on the same project runtime
# as verify_run.py, where requests_go and loguru are installed.
_PROJECT_PYTHON = '/opt/miniconda3/envs/pythonProject/bin/python'
if (os.environ.get('_ALIV2_BATCH_BOOTSTRAPPED') != '1'
        and os.path.exists(_PROJECT_PYTHON)
        and sys.executable != _PROJECT_PYTHON):
    env = dict(os.environ, _ALIV2_BATCH_BOOTSTRAPPED='1')
    os.execve(_PROJECT_PYTHON, [_PROJECT_PYTHON, os.path.abspath(__file__), *sys.argv[1:]], env)

from pathlib import Path


HERE = Path(__file__).resolve().parent
RUNNER = HERE / 'verify_run.py'

try:
    from loguru import logger as _logger
    _logger.remove()
    _logger.add(sys.stdout, format='<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | {message}',
                colorize=True, enqueue=True)
except ImportError:
    logging.basicConfig(
        level=logging.INFO, stream=sys.stdout,
        format='%(asctime)s | %(levelname)-7s | %(message)s',
        datefmt='%H:%M:%S')
    _logger = logging.getLogger('aliv2.batch')


def emit(index, line):
    """Forward only operationally useful lines from a worker."""
    line = line.strip()
    if not line:
        return
    concise = None
    if '[2] Init ok' in line:
        concise = re.sub(r'\| rt:.*$', '', line)
    elif '[feilin]' in line:
        concise = line
    elif '[4] sg VM ready:' in line:
        concise = re.sub(r' \| cache: (hit|miss)$', r' | cache=\1', line)
    elif '[4.5] UploadLog:' in line:
        concise = '[4.5] UploadLog: Success' if "'Success': True" in line else '[4.5] UploadLog: failed'
    elif '[5] FeiLin runtime:' in line:
        concise = re.sub(r'\| GatherCost:.*$', '', line)
    elif '[6.5] device Log' in line:
        m = re.search(r'device (Log[23]): \{.*?[\'\"]Code[\'\"]: [\'\"]?(\d+)', line)
        concise = f'[6.5] {m.group(1)}: Code {m.group(2)}' if m else '[6.5] device log: error'
    elif '==== VerifyCode:' in line:
        concise = line
    elif '[transport]' in line:
        concise = '[transport] fallback active'
    if concise is None:
        return
    level = 'success' if 'VerifyResult: True' in concise or 'Code 200' in concise else 'info'
    message = f'run={index} | {concise}'
    if hasattr(_logger, level):
        getattr(_logger, level)(message)
    else:
        _logger.info(message)


def run_one(index, timeout, extra_env):
    env = os.environ.copy()
    env.update(extra_env)
    env['ALIV2_RUN_ID'] = str(index)
    started = time.time()
    try:
        proc = subprocess.Popen(
            [sys.executable, '-u', str(RUNNER)], cwd=HERE, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1)
        lines = []
        deadline = time.time() + timeout
        while True:
            line = proc.stdout.readline()
            if line:
                lines.append(line)
                emit(index, line)
                continue
            if proc.poll() is not None:
                break
            if time.time() >= deadline:
                proc.kill()
                proc.wait()
                raise subprocess.TimeoutExpired(proc.args, timeout,
                                                 output=''.join(lines))
        output = ''.join(lines)
        m = re.search(r'VerifyCode:\s*([^|\s]+)\s*\|\s*VerifyResult:\s*(\w+)', output)
        code = m.group(1) if m else None
        result = (m.group(2).lower() == 'true') if m else False
        return {
            'run': index, 'ok': result and code == 'T001', 'code': code,
            'verify_result': result, 'returncode': proc.returncode,
            'elapsed_ms': round((time.time() - started) * 1000),
            'output_tail': output[-1000:],
        }
    except subprocess.TimeoutExpired as exc:
        return {'run': index, 'ok': False, 'code': None,
                'verify_result': False, 'error': f'timeout>{timeout}s',
                'elapsed_ms': round((time.time() - started) * 1000),
                'output_tail': (exc.stdout or '')[-1000:]}
    except Exception as exc:
        return {'run': index, 'ok': False, 'code': None,
                'verify_result': False, 'error': repr(exc),
                'elapsed_ms': round((time.time() - started) * 1000)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=int, required=True, help='total verify attempts')
    parser.add_argument('--workers', type=int, default=4, help='parallel processes')
    parser.add_argument('--timeout', type=int, default=60, help='per-run timeout seconds')
    parser.add_argument('--reuse-state', action='store_true',
                        help='reuse runtime/state/device.json token1 (not recommended for batches)')
    parser.add_argument('--fresh-state', action='store_true',
                        help='force a fresh device state for every attempt (default)')
    args = parser.parse_args()
    if args.runs < 1 or args.workers < 1:
        parser.error('--runs and --workers must be positive')
    workers = min(args.workers, args.runs)
    env = {
        # verify_run.py always executes the current FeiLin script; no trace or
        # legacy payload mode is involved in batch runs.
        'INIT_BROWSER_DELAY': '0', 'INIT_PRELOAD_PAGE_ASSETS': '0',
        'INIT_PRELOAD_JS': '0', 'UPLOAD_AT_MS': '0', 'LOG2_AT_MS': '0',
        'LOG3_AT_MS': '0', 'VERIFY_AT_MS': '0',
    }
    # A batch should not present every attempt as the same logical device.
    # Single-run verify_run.py keeps the normal persistent-state behavior.
    if args.fresh_state or not args.reuse_state:
        env['FRESH_DEVICE_STATE'] = '1'
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_one, i, args.timeout, env)
                   for i in range(1, args.runs + 1)]
        results = [future.result() for future in futures]
    results.sort(key=lambda item: item['run'])
    passed = sum(item['ok'] for item in results)
    elapsed_ms = round((time.time() - started) * 1000)
    _logger.info('batch finished | runs={} workers={} passed={} failed={} rate={:.1%} elapsed={}ms',
                 args.runs, workers, passed, args.runs - passed,
                 passed / args.runs, elapsed_ms)
    for item in results:
        level = 'success' if item['ok'] else 'error'
        message = 'run={} | code={} result={} elapsed={}ms'.format(
            item['run'], item.get('code') or '-',
            str(item.get('verify_result', False)).lower(), item['elapsed_ms'])
        if hasattr(_logger, level):
            getattr(_logger, level)(message)
        else:
            _logger.info(message)
    return 0 if passed == args.runs else 1


if __name__ == '__main__':
    raise SystemExit(main())
