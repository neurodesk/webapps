# QSMbly: Browser-Based Quantitative Susceptibility Mapping

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Ready-green.svg)](https://pages.github.com/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-Powered-blue.svg)](https://webassembly.org/)

A complete **Quantitative Susceptibility Mapping (QSM)** pipeline that runs entirely in your web browser using WebAssembly. No installation, no backend servers, no data uploads — just pure client-side MRI processing.

[ACCESS QSMbly HERE](https://qsmbly.neurodesk.org/)

## Features

- **Completely Private**: All processing happens locally in your browser — your data never leaves your computer
- **Zero Installation**: No Python, MATLAB, or specialized software required
- **Cross-Platform**: Works on Windows, macOS, Linux, and even mobile devices
- **Interactive**: Real-time visualization with NiiVue, adjustable contrast, and masking thresholds
- **Portable**: Static files can be hosted anywhere (GitHub Pages, local server, etc.)
- **Comprehensive**: 20+ algorithms covering the complete QSM pipeline

## Algorithms

QSMbly's QSM algorithms are provided by [QSM.rs](https://github.com/astewartau/QSM.rs), a standalone Rust library compiled to WebAssembly. See the [QSM.rs README](https://github.com/astewartau/QSM.rs#algorithms) for a complete list of supported algorithms with citations.

## Quick Start

### Option 1: Use Online
1. Visit [qsmbly.neurodesk.org](https://qsmbly.neurodesk.org/)
2. Upload DICOM files or NIfTI magnitude/phase images
3. Set acquisition parameters (Echo Time, Field Strength)
4. Run the pipeline

### Option 2: Run Locally
```bash
git clone https://github.com/astewartau/qsmbly.git
cd qsmbly
./run.sh
# Open http://localhost:8080
```

## Building from Source

### Prerequisites
1. **Install Rust**: https://rustup.rs/
2. **Install wasm-pack**:
   ```bash
   cargo install wasm-pack
   ```

### Build and Run
```bash
# Standard build (maximum browser compatibility)
./build.sh

# SIMD-accelerated build (faster, requires modern browsers)
./build.sh --simd

# Start development server
./run.sh
```

### SIMD Acceleration

The `--simd` flag enables 128-bit SIMD vectorization for faster processing of iterative algorithms. This provides approximately **2-4x speedup** for element-wise operations.

| Browser | Minimum Version |
|---------|-----------------|
| Chrome  | 91+ (May 2021)  |
| Firefox | 89+ (June 2021) |
| Safari  | 16.4+ (March 2023) |
| Edge    | 91+ (May 2021)  |

### Running Tests
```bash
npm install
npm test
```

## Repository Structure

```
qsmbly/
├── index.html              # Main application interface
├── build.sh                # WASM build script
├── run.sh                  # Development server
├── test.sh                 # Rust test runner
├── js/
│   ├── qsm-app-romeo.js    # Main application logic
│   ├── qsm-worker-pure.js  # Web worker for pipeline execution
│   ├── app/
│   │   └── config.js       # Centralized configuration
│   ├── controllers/        # UI controllers (file I/O, pipeline, viewer, etc.)
│   ├── modules/            # UI modules (NIfTI utils, masking, viewer)
│   └── workers/            # Web workers (DiCompare)
├── css/
│   └── modern-styles.css   # Application styling
├── wasm/                   # Compiled WebAssembly (served to browser)
├── rust-wasm/              # WASM binding layer
│   ├── Cargo.toml          # Depends on qsm-core
│   └── src/lib.rs          # Thin wasm_bindgen wrappers (59 exports)
├── dcm2niix/               # DICOM-to-NIfTI conversion (WASM)
├── schemas/                # DiCompare validation schemas
├── niivue/                 # NiiVue neuroimaging viewer
└── nifti-js/               # NIfTI reader (JavaScript)
```

## Technical Stack

- **[QSM.rs](https://github.com/astewartau/QSM.rs)**: Core QSM algorithms (Rust, compiled to WebAssembly)
- **[wasm-bindgen](https://github.com/rustwasm/wasm-bindgen)**: JavaScript/WASM interop
- **[NiiVue](https://github.com/niivue/niivue)**: WebGL neuroimaging viewer
- **[dcm2niix](https://github.com/rordenlab/dcm2niix)**: DICOM conversion (WASM build)
- **[Pyodide](https://pyodide.org/)**: Python in browser (for DiCompare validation)

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Issues & Support

- **Bug Reports**: [GitHub Issues](https://github.com/astewartau/qsmbly/issues)
- **Feature Requests**: [GitHub Discussions](https://github.com/astewartau/qsmbly/discussions)
