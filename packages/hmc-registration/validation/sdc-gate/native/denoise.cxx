// Native DenoiseImage (ANTs Examples/DenoiseImage.cxx, unchanged) for e2e.sh.
#include <string>
#include <vector>
namespace ants {
int DenoiseImage(std::vector<std::string>, std::ostream *);
}
int main(int argc, char * argv[]) { return ants::DenoiseImage(std::vector<std::string>(argv + 1, argv + argc), nullptr); }
