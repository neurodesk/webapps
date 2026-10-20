// ANTs N4BiasFieldCorrection for WebAssembly: argv as the ANTs command line takes it, NIfTI
// only, one ITK thread so results do not depend on the host.
// The ANTs header uses std::string, std::vector and std::ostream without including them.
#include <iostream>
#include <string>
#include <vector>
#include "N4BiasFieldCorrection.h"
#include "itkMultiThreaderBase.h"
#include "itkNiftiImageIOFactory.h"

int main(int argc, char* argv[]) {
  itk::NiftiImageIOFactory::RegisterOneFactory();
  itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
  itk::MultiThreaderBase::SetGlobalDefaultThreader(itk::MultiThreaderBase::ThreaderEnum::Platform);
  try {
    return ants::N4BiasFieldCorrection(std::vector<std::string>(argv + 1, argv + argc), nullptr);
  } catch (const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
