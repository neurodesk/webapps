// SPDX-License-Identifier: GPL-3.0-or-later
#include "DRBUDDI_Diffeo.h"
#include "itkImageFileReader.h"
#include "itkImageFileWriter.h"
#include "itkNiftiImageIOFactory.h"
#include "itkMultiThreaderBase.h"
std::vector<uint> OMPTHREADBASE::Nthreads_per_OMP_thread;
std::atomic_uint OMPTHREADBASE::NAvailableCores{1};
int getNCores() { return 1; }
std::string GetTORTOISEVersion() { return "1ffb8f3-feasibility"; }
int main(int argc, char **argv) {
  if (argc < 5) return 2;
  try {
    itk::NiftiImageIOFactory::RegisterOneFactory();
    itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
    itk::MultiThreaderBase::SetGlobalMaximumNumberOfThreads(1);
    std::vector<char *> options{argv[0]};
    for (int i = 5; i < argc; ++i) options.push_back(argv[i]);
    auto parser = new DRBUDDI_PARSERBASE(options.size(), options.data(), false);
    parser->Parse(options.size(), options.data());
    auto up = itk::ImageFileReader<ImageType3D>::New();
    auto down = itk::ImageFileReader<ImageType3D>::New();
    up->SetFileName(argv[1]);
    down->SetFileName(argv[2]);
    up->Update();
    down->Update();
    const int axis = std::stoi(argv[3]);
    if (axis < 0 || axis > 2) return 2;
    vnl_vector<double> direction(3, 0.0);
    direction[axis] = 1.0;
    DRBUDDI_Diffeo solver;
    solver.SetParser(parser);
    solver.SetB0UpImage(up->GetOutput());
    solver.SetB0DownImage(down->GetOutput());
    solver.SetUpPEVector(direction);
    solver.SetDownPEVector(direction);
    solver.Process();
    auto writer = itk::ImageFileWriter<DisplacementFieldType>::New();
    writer->SetFileName(std::string(argv[4]) + "-up.nii");
    writer->SetInput(solver.getDefFINV());
    writer->Update();
    writer->SetFileName(std::string(argv[4]) + "-down.nii");
    writer->SetInput(solver.getDefMINV());
    writer->Update();
    parser->Delete();
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
