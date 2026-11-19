//! Crash points for the restart tests: with the `test-hooks` feature, a process started with
//! `FEDIMINT_RECEIVER_CRASH_AT=<name>` aborts at the point of that name, as a power cut would stop
//! it. Without the feature (every release build) this is a no-op.

#[cfg(feature = "test-hooks")]
pub fn crash_point(name: &str) {
    if std::env::var("FEDIMINT_RECEIVER_CRASH_AT").is_ok_and(|v| v == name) {
        tracing::warn!("crash point {name}: aborting");
        std::process::abort();
    }
}

#[cfg(not(feature = "test-hooks"))]
pub fn crash_point(_name: &str) {}
