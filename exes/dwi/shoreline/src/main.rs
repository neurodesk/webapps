// SPDX-License-Identifier: Apache-2.0
//! `shoreline`: head motion, eddy-current, susceptibility and slice outlier correction of a
//! diffusion series (see the library documentation). The options follow FSL eddy's names
//! where they mean the same thing, so that existing scripts translate directly.

use dwi_shoreline::cli;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let threads = cli::parse(&argv)
        .get("nthr")
        .and_then(|t| t.parse::<usize>().ok())
        .unwrap_or(0);
    if threads > 0 {
        if let Err(e) = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()
        {
            eprintln!("shoreline: {e}");
            std::process::exit(1);
        }
    }
    if let Err(e) = cli::run(&argv, &mut cli::FileSystem, &mut |line| eprintln!("{line}")) {
        eprintln!("shoreline: {e}");
        std::process::exit(1);
    }
}
