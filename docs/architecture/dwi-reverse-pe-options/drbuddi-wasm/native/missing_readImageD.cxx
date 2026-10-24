// SPDX-License-Identifier: GPL-3.0-or-later
// readImageD (TORTOISE defines.cxx) is not in the probe's source list. The
// WebAssembly link leaves it as an import that aborts when called; the solver
// calls it only for an initial FINV/MINV field, which the probe never passes.
// This native stub does the same.
#include <cstdlib>
#include <iostream>
#include <string>
#include "itkImage.h"
#include "itkVector.h"
template <typename ImageType>
typename ImageType::Pointer readImageD(std::string filename) {
  std::cerr << "readImageD is not in the probe: " << filename << std::endl;
  std::abort();
}
template itk::Image<itk::Vector<double, 3>, 3>::Pointer
readImageD<itk::Image<itk::Vector<double, 3>, 3>>(std::string);
