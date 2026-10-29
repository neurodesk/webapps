// The registration modes the native build lacks: 2D and 4D always, 3D double unless HMC_NATIVE_DOUBLE.
#include "antsCommandLineParser.h"
#include <iostream>
namespace ants {
using Parser = itk::ants::CommandLineParser;
static int unsupported() { std::cerr << "This native build supports only 3D registration." << std::endl; return 1; }
int antsRegistration2DFloat(Parser::Pointer&) { return unsupported(); }
int antsRegistration4DFloat(Parser::Pointer&) { return unsupported(); }
int antsRegistration2DDouble(Parser::Pointer&) { return unsupported(); }
int antsRegistration4DDouble(Parser::Pointer&) { return unsupported(); }
#ifndef HMC_NATIVE_DOUBLE
int antsRegistration3DDouble(Parser::Pointer&) { return unsupported(); }
#endif
}
