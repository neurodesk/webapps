/// A reference test without its data passes with a notice, unless
/// FIDA_REQUIRE_REFERENCE is set (as in CI): then missing data is a failure.
pub fn skip(why: &str) {
    if std::env::var_os("FIDA_REQUIRE_REFERENCE").is_some() {
        panic!("{why}: FIDA_REQUIRE_REFERENCE is set (fetch the data with validation/fetch_reference.py)");
    }
    eprintln!("skipping: {why} (see validation/README.md)");
}
