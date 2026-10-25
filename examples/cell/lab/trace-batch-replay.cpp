#include "FirefoxTraceBatchWriter.h"

#include <chrono>
#include <fstream>
#include <iostream>
#include <string>

// Replays captured LF-delimited events as bytes; never executes page scripts.
int main(int argc, char** argv) {
  if (argc != 4) return 2;
  std::ifstream input(argv[1], std::ios::binary);
  if (!input) return 3;
  bool batched = std::string(argv[3]) == "batch";
  size_t events = 0, bytes = 0, opens = 0;
  auto start = std::chrono::steady_clock::now();
  bool done = false;
  while (!done) {
    mozilla::dom::FirefoxTraceBatchWriter writer;
    size_t batchBytes = 0;
    std::string line;
    while (batchBytes < 512 * 1024) {
      if (!std::getline(input, line)) { done = true; break; }
      line += '\n';
      FILE* file;
      if (batched) {
        if (!batchBytes) ++opens;
        file = writer.Open(mozilla::dom::FirefoxTraceBatchWriter::Stream::JS,
                           ".", argv[2]);
      } else {
        ++opens;
        file = fopen(argv[2], "a");
      }
      if (!file || fwrite(line.data(), 1, line.size(), file) != line.size())
        return 4;
      if (!batched && fclose(file)) return 5;
      ++events;
      bytes += line.size();
      batchBytes += line.size();
    }
  }
  double seconds = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - start).count();
  std::cout << "{\"events\":" << events << ",\"bytes\":" << bytes
            << ",\"opens\":" << opens << ",\"seconds\":" << seconds
            << "}\n";
  return input.bad() ? 6 : 0;
}
