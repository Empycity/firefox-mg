"""Exercise the actual portable helper shipped in the Gecko patch."""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = "js/src/vm/FirefoxTraceValueTransport.h"


def patch_header():
    patch = (ROOT / "patches/gecko-firefox-trace.patch").read_text()
    section = patch.split(f"diff --git a/{NAME} b/{NAME}\n", 1)[1]
    section = section.partition("\ndiff --git ")
    section = section[0] + ("\n" if section[1] else "")
    return "".join(line[1:] for line in section.splitlines(keepends=True)
                   if line.startswith("+") and not line.startswith("+++"))


@unittest.skipUnless(shutil.which("clang++") or shutil.which("c++"), "C++ compiler required")
class TraceValueTransportTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("zsh"), "zsh installer runtime required")
    def test_installer_uses_linker_output_instead_of_stale_packaged_xul(self):
        source = (ROOT / "tools/install-trace-runtime.sh").read_text()
        helpers = source[source.index("find_default_xul() {"):source.index("\nSOURCE_XUL=")]
        with tempfile.TemporaryDirectory(prefix="trace install selection ") as directory:
            work = pathlib.Path(directory)
            dist = work / "gecko-dev/obj-test/dist"
            stale = dist / "Nightly.app/Contents/MacOS/XUL"
            stale.parent.mkdir(parents=True)
            stale.write_text("stale")
            current = dist / "bin/XUL"
            script = helpers + '\nROOT="$1"\nfind_default_xul\n'
            command = [shutil.which("zsh"), "-c", script, "test", str(work)]
            self.assertEqual(subprocess.check_output(command, text=True).strip(), str(stale))
            current.parent.mkdir()
            current.write_text("linked")
            self.assertEqual(subprocess.check_output(command, text=True).strip(), str(current))
            mapping = helpers + '\nsource_app_for_xul "$1"\n'
            actual = subprocess.check_output([shutil.which("zsh"), "-c", mapping, "test", str(current)], text=True)
            self.assertEqual(actual.strip(), str(dist / "Nightly.app"))
            stale.unlink()
            current.unlink()
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, "")

    def test_exact_cache_eviction_reset_and_utf8_nul_json(self):
        with tempfile.TemporaryDirectory(prefix="trace-value-transport-") as directory:
            work = pathlib.Path(directory)
            (work / "FirefoxTraceValueTransport.h").write_text(patch_header())
            (work / "test.cpp").write_text(r'''
#include "FirefoxTraceValueTransport.h"
#include <cassert>
#include <string>
int main() {
  FirefoxTraceValueTransportCache cache;
  assert(!cache.Contains("first", 3));
  cache.Remember("first", 3);
  assert(cache.Contains("first", 3));
  assert(!cache.Contains("first", 4));
  assert(!cache.Contains("second", 3));
  assert(!cache.Contains(nullptr, 0));
  assert(!cache.Contains("", 0));
  std::string longKey(65, 'a');
  cache.Remember(longKey.c_str(), 0);
  assert(!cache.Contains(longKey.c_str(), 0));
  // More keys than slots: for each hit the exact previous key/length must
  // match. Evicted keys must be retried; an eviction is not an accepted send.
  for (size_t i = 0; i < 20000; ++i) {
    std::string key = std::to_string(i);
    assert(!cache.Contains(key.c_str(), i));
    cache.Remember(key.c_str(), i);
    assert(cache.Contains(key.c_str(), i));
  }
  cache.Clear();
  assert(!cache.Contains("19999", 19999));
  // A failed transfer must not be remembered by the caller.
  assert(!cache.Contains("failed", 5));
  assert(!cache.Contains("failed", 5));
  const char value[] = {'a', 0, '\n', '"', '\\', char(0xe4), char(0xb8),
                        char(0xad), char(0xf0), char(0x9f), char(0x98), char(0x80)};
  FILE* file = fopen("preview.jsonl", "wb");
  assert(file);
  for (size_t limit = 0; limit <= sizeof(value); ++limit) {
    FirefoxTraceWriteJsonBytes(file, value, sizeof(value), limit);
    fputc('\n', file);
  }
  assert(fclose(file) == 0);
}
''')
            compiler = shutil.which("clang++") or shutil.which("c++")
            subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "test.cpp", "-o", "test"], cwd=work, check=True, capture_output=True)
            subprocess.run([str(work / "test")], cwd=work, check=True, capture_output=True)
            raw = b'a\0\n"\\' + "中😀".encode()
            lines = (work / "preview.jsonl").read_bytes().split(b"\n")[:-1]
            self.assertEqual(len(lines), len(raw) + 1)
            for limit, line in enumerate(lines):
                expected = raw[:limit].decode("utf-8", errors="ignore")
                if limit < len(raw):
                    expected += "..."
                self.assertEqual(json.loads(line), expected)

    def test_published_helper_matches_checkout(self):
        local = ROOT / "gecko-dev" / NAME
        if local.exists():
            self.assertEqual(local.read_text(), patch_header())

    def test_actual_sender_retries_failed_writes_and_separates_directories(self):
        # Compile the function from the distributed patch, not a hand-written
        # model. Replace only its Gecko/runtime dependencies with small stubs.
        patch = (ROOT / "patches/gecko-firefox-trace.patch").read_text()
        section = patch.split("diff --git a/js/src/vm/Interpreter.cpp b/js/src/vm/Interpreter.cpp\n", 1)[1]
        section = section.split("\ndiff --git ", 1)[0]
        source = "\n".join(line[1:] for line in section.split("\n")
                           if line[:1] in {"+", " "} and not line.startswith("+++"))
        start = source.index("bool FirefoxTraceWriteJSValueStoreFile(")
        end = source.index("// Sink-time artifacts", start)
        function = source[start:end]
        with tempfile.TemporaryDirectory(prefix="trace-value-sender-") as directory:
            work = pathlib.Path(directory)
            (work / "FirefoxTraceValueTransport.h").write_text(patch_header())
            stubs = r'''
#include "FirefoxTraceValueTransport.h"
#include <cassert>
#include <sys/stat.h>
#include <unistd.h>
#define SprintfLiteral(buffer, ...) snprintf(buffer, sizeof(buffer), __VA_ARGS__)
static FirefoxTraceValueTransportCache sFirefoxTraceSentJSValues;
static char sFirefoxTraceSentJSValuesDir[4096] = "";
static const char* directory = "one";
static bool cacheEnabled = true;
static bool sendOK = false;
static unsigned sends = 0;
bool FirefoxTraceBaseEnabled() { return true; }
const char* FirefoxTraceLogDir() { return directory; }
bool FirefoxTraceEnvEnabledAlias(const char*, const char*, bool) { return cacheEnabled; }
bool Send(const char*, const char*, const char*, size_t) { ++sends; return sendOK; }
static auto FirefoxTraceSendValueToParent = &Send;
'''
            tests = r'''
int main() {
  char path[512];
  const char value[] = {'a', 0, 'b'};
  mkdir("blocked", 0755);
  FILE* blocker = fopen("blocked/file", "wb");
  assert(blocker && fclose(blocker) == 0);
  directory = "blocked/file/trace";
  assert(!FirefoxTraceWriteJSValueStoreFile("v1", "key", value, 3, path, sizeof(path)));
  assert(!sFirefoxTraceSentJSValues.Contains("key", 3));
  unlink("blocked/file");
  mkdir("blocked/file", 0755);
  assert(FirefoxTraceWriteJSValueStoreFile("v2", "key", value, 3, path, sizeof(path)));
  assert(sFirefoxTraceSentJSValues.Contains("key", 3));
  assert(strcmp(path, "values/key.txt") == 0);
  unsigned before = sends;
  assert(FirefoxTraceWriteJSValueStoreFile("v3", "key", value, 3, path, sizeof(path)));
  assert(sends == before);
  directory = "two";
  sendOK = true;
  assert(FirefoxTraceWriteJSValueStoreFile("v4", "key", value, 3, path, sizeof(path)));
  assert(sends == before + 1);
  assert(FirefoxTraceWriteJSValueStoreFile("v5", "key", value, 3, path, sizeof(path)));
  assert(sends == before + 1);
  cacheEnabled = false;
  assert(FirefoxTraceWriteJSValueStoreFile("v6", "key", value, 3, path, sizeof(path)));
  assert(sends == before + 2);
}
'''
            (work / "test.cpp").write_text(stubs + function + tests)
            compiler = shutil.which("clang++") or shutil.which("c++")
            subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "test.cpp", "-o", "test"], cwd=work, check=True, capture_output=True)
            subprocess.run([str(work / "test")], cwd=work, check=True, capture_output=True)
            self.assertEqual((work / "blocked/file/trace/values/key.txt").read_bytes(), b"a\0b")

    def test_flush_precedes_configuration_and_ack(self):
        local = ROOT / "gecko-dev/dom/ipc/ContentChild.cpp"
        if not local.exists():
            self.skipTest("Optional Gecko checkout not present")
        source = local.read_text().split("ContentChild::RecvFirefoxTraceRuntimeConfig(", 1)[1]
        source = source.split("return IPC_OK();", 1)[0]
        self.assertLess(source.index("FirefoxTraceDrainJSBatchForControl()"),
                        source.index("FirefoxTraceApplyRuntimeConfigJson"))
        self.assertLess(source.index("FirefoxTraceApplyRuntimeConfigJson"),
                        source.index("SendFirefoxTraceRuntimeConfigApplied"))
        self.assertIn("drained && SendFirefoxTraceRuntimeConfigApplied", source)

    def test_drain_reuses_existing_ipc_without_protocol_abi_changes(self):
        local = ROOT / "gecko-dev/dom/ipc/PContent.ipdl"
        if not local.exists():
            self.skipTest("Optional Gecko checkout not present")
        self.assertNotIn("FirefoxTraceJSBatchDrain(", local.read_text())
        for name in ["ContentParent.cpp", "ContentChild.cpp"]:
            source = (local.parent / name).read_text()
            self.assertEqual(source.count('FIREFOX_TRACE_CONTROL_DRAIN_V1\\n'), 1)

    def test_actual_control_drain_keeps_failed_tail_and_writes_after_pause(self):
        patch = (ROOT / "patches/gecko-firefox-trace.patch").read_text()
        section = patch.split("diff --git a/js/src/vm/Interpreter.cpp b/js/src/vm/Interpreter.cpp\n", 1)[1]
        section = section.split("\ndiff --git ", 1)[0]
        source = "\n".join(line[1:] for line in section.split("\n")
                           if line[:1] in {"+", " "} and not line.startswith("+++"))
        start = source.index('extern "C" bool FirefoxTraceDrainJSBatchForControl() {')
        end = source.index("void FirefoxTraceQueueJSBatchEvent(", start)
        function = source[start:end]
        with tempfile.TemporaryDirectory(prefix="trace-control-drain-") as directory:
            work = pathlib.Path(directory)
            (work / "test.cpp").write_text(r'''
#include <cassert>
#include <cstdio>
#include <cstring>
static char bytes[] = "{\"tail\":true}\n";
static char* sFirefoxTraceJSBatchData = bytes;
static size_t sFirefoxTraceJSBatchLen = sizeof(bytes) - 1;
static bool writable = false;
static bool active = false;
static bool (*FirefoxTraceSendJSBatchDrainToParent)(const char*, size_t) = nullptr;
static bool accept = false;
static unsigned sends = 0;
bool SendDrain(const char* data, size_t length) {
  assert(length == sizeof(bytes) - 1 && memcmp(data, bytes, length) == 0);
  ++sends;
  return accept;
}
FILE* FirefoxTraceOpenJSLog() {
  return writable ? fopen("tail.jsonl", "ab") : nullptr;
}
''' + function + r'''
int main() {
  assert(!active);
  assert(!FirefoxTraceDrainJSBatchForControl());
  assert(sFirefoxTraceJSBatchLen == sizeof(bytes) - 1);
  writable = true;
  assert(FirefoxTraceDrainJSBatchForControl());
  assert(sFirefoxTraceJSBatchLen == 0);
  assert(FirefoxTraceDrainJSBatchForControl());
  sFirefoxTraceJSBatchLen = sizeof(bytes) - 1;
  FirefoxTraceSendJSBatchDrainToParent = &SendDrain;
  assert(!FirefoxTraceDrainJSBatchForControl());
  assert(sFirefoxTraceJSBatchLen == sizeof(bytes) - 1 && sends == 1);
  accept = true;
  assert(FirefoxTraceDrainJSBatchForControl());
  assert(sFirefoxTraceJSBatchLen == 0 && sends == 2);
}
''')
            compiler = shutil.which("clang++") or shutil.which("c++")
            subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "test.cpp", "-o", "test"], cwd=work, check=True, capture_output=True)
            subprocess.run([str(work / "test")], cwd=work, check=True, capture_output=True)
            self.assertEqual((work / "tail.jsonl").read_bytes(), b'{"tail":true}\n')


if __name__ == "__main__":
    unittest.main()
