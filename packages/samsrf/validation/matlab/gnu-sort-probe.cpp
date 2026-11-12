// Prints, for deterministic inputs with many equal keys, the order std::sort leaves.
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <vector>
struct Item { long long key; int id; };
int main() {
  uint64_t state = 88172645463325252ull;
  auto next = [&]() { state ^= state << 13; state ^= state >> 7; state ^= state << 17; return state; };
  for (int n : {2, 5, 16, 17, 18, 31, 64, 100, 257, 1000}) {
    for (int keys : {1, 2, 3, 7, 50}) {
      std::vector<Item> v(n);
      for (int i = 0; i < n; ++i) v[i] = {(long long)(next() % keys), i};
      std::sort(v.begin(), v.end(), [](const Item& a, const Item& b) { return b.key < a.key; });
      printf("%d %d", n, keys);
      for (auto& x : v) printf(" %d", x.id);
      printf("\n");
    }
  }
}
