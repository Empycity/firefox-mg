"""Portable byte-preservation tests for the Gecko patch's batch-local writer."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def patch_header():
    patch = (ROOT / "patches/gecko-firefox-trace.patch").read_text()
    name = "dom/ipc/FirefoxTraceBatchWriter.h"
    section = patch.split(f"diff --git a/{name} b/{name}\n", 1)[1]
    section = section.partition("\ndiff --git ")
    section = section[0] + ("\n" if section[1] else "")
    return "".join(line[1:] for line in section.splitlines(keepends=True)
                   if line.startswith("+") and not line.startswith("+++"))


@unittest.skipUnless(shutil.which("clang++") or shutil.which("c++"), "C++ compiler required")
class TraceBatchWriterTests(unittest.TestCase):
    def test_mixed_stream_bytes_closure_rotation_and_failed_open_retry(self):
        with tempfile.TemporaryDirectory(prefix="trace-batch-writer-") as directory:
            work = pathlib.Path(directory)
            (work / "FirefoxTraceBatchWriter.h").write_text(patch_header())
            (work / "test.cpp").write_text(r'''
#include "FirefoxTraceBatchWriter.h"
#include <cassert>
#include <string>
#include <type_traits>
using Writer = mozilla::dom::FirefoxTraceBatchWriter;
static_assert(!std::is_copy_constructible<Writer>::value);
int main() {
  const std::string event = "{\"value\":\"a\xe2\x80\xa8" "b\"}\n";
  {
    Writer writer;
    for (size_t turn = 0; turn < 20; ++turn) {
      for (size_t slot = 0; slot < 9; ++slot) {
        std::string path = std::to_string(slot) + ".jsonl";
        auto stream = static_cast<Writer::Stream>(slot);
        FILE* file = writer.Open(stream, ".", path.c_str());
        assert(file && file == writer.Open(stream, ".", path.c_str()));
        assert(fwrite(event.data(), 1, event.size(), file) == event.size());
      }
    }
    assert(!writer.Open(Writer::Stream::Count, ".", "invalid"));
    assert(!writer.Open(static_cast<Writer::Stream>(999), ".", "invalid"));
  }
  {
    Writer writer;
    assert(!writer.Open(Writer::Stream::JS, "missing/child", "missing/child/x"));
    mkdir("missing", 0755);
    FILE* file = writer.Open(Writer::Stream::JS, "missing/child", "missing/child/x");
    assert(file);
    const char bytes[] = {'a', 0, 'b', '\n'};
    assert(fwrite(bytes, 1, sizeof(bytes), file) == sizeof(bytes));
  }
  {
    Writer writer;
    FILE* file = writer.Open(Writer::Stream::JS, "rotated", "rotated/js");
    assert(file);
    std::string large(1024 * 1024, 'x');
    assert(fwrite(large.data(), 1, large.size(), file) == large.size());
  }
}
''')
            compiler = shutil.which("clang++") or shutil.which("c++")
            subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "test.cpp", "-o", "test"], cwd=work, check=True, capture_output=True)
            subprocess.run([str(work / "test")], cwd=work, check=True, capture_output=True)
            expected = '{"value":"a\u2028b"}\n'.encode() * 20
            for slot in range(9):
                self.assertEqual((work / f"{slot}.jsonl").read_bytes(), expected)
            self.assertEqual((work / "missing/child/x").read_bytes(), b"a\0b\n")
            self.assertEqual((work / "rotated/js").read_bytes(), b"x" * (1024 * 1024))
            self.assertFalse((work / "invalid").exists())

    def test_published_header_matches_local_checkout(self):
        local = ROOT / "gecko-dev/dom/ipc/FirefoxTraceBatchWriter.h"
        if local.exists():
            self.assertEqual(patch_header(), local.read_text())

    def test_runtime_cache_sentinel_is_removed_before_signing(self):
        for relative in ["tools/install-trace-runtime.sh",
                         "skills/firefox-trace-agent/tools/install-trace-runtime.sh"]:
            source = (ROOT / relative).read_text()
            cleanup = 'find "$RUNTIME_APP" -type f -name .purgecaches -delete'
            self.assertLess(source.index(cleanup), source.index('codesign --force --deep --sign - "$RUNTIME_APP"'))
            with tempfile.TemporaryDirectory(prefix="trace-signing-") as directory:
                work = pathlib.Path(directory)
                bundle = work / "Nightly space.app"
                resources = bundle / "Contents/Resources/browser"
                resources.mkdir(parents=True)
                (resources / ".purgecaches").write_text("")
                (resources / "keep.txt").write_text("keep")
                (work / ".purgecaches").write_text("outside")
                subprocess.run(["sh", "-c", 'RUNTIME_APP="$1"; ' + cleanup,
                                "cleanup", str(bundle)], check=True)
                self.assertFalse((resources / ".purgecaches").exists())
                self.assertEqual((resources / "keep.txt").read_text(), "keep")
                self.assertEqual((work / ".purgecaches").read_text(), "outside")


if __name__ == "__main__":
    unittest.main()
