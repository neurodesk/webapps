#include <vector>
#include <string>
#include <iostream>
#include "DenoiseImage.h"
#include "itkNiftiImageIOFactory.h"
#include "itkMultiThreaderBase.h"
// ANTs DenoiseImage on one ITK thread, so the result does not depend on the host.
int main(int argc, char* argv[]) {
  itk::NiftiImageIOFactory::RegisterOneFactory();
  itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
  itk::MultiThreaderBase::SetGlobalDefaultThreader(itk::MultiThreaderBase::ThreaderEnum::Platform);
  try {
    return ants::DenoiseImage(std::vector<std::string>(argv + 1, argv + argc), nullptr);
  }
  catch (const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
