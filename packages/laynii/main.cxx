#include <cstring>
#include <exception>
#include <iostream>

int ln2_layers_main(int argc, char* argv[]);
int ln2_profile_main(int argc, char* argv[]);

int main(int argc, char* argv[]) {
  if (argc < 2) {
    std::cerr << "Usage: laynii <LN2_LAYERS|LN2_PROFILE> [args...]" << std::endl;
    return 1;
  }
  try {
    if (std::strcmp(argv[1], "LN2_LAYERS") == 0) {
      return ln2_layers_main(argc - 1, argv + 1);
    }
    if (std::strcmp(argv[1], "LN2_PROFILE") == 0) {
      return ln2_profile_main(argc - 1, argv + 1);
    }
    std::cerr << "Unknown LayNii command: " << argv[1] << std::endl;
    return 1;
  } catch (const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
