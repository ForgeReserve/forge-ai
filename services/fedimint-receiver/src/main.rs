//! `fedimint-receiver`: serve the API (no arguments), or `fedimint-receiver healthcheck` to ask a
//! running one for `/health` (the container's health check: the image has no curl).

use std::io::{Read as _, Write as _};
use std::time::Duration;

use fedimint_receiver::config::Config;
use tracing_subscriber::EnvFilter;

fn main() -> std::process::ExitCode {
    let healthcheck = std::env::args().nth(1).is_some_and(|a| a == "healthcheck");
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fedimint-receiver: {e:#}");
            return std::process::ExitCode::from(2);
        }
    };
    if healthcheck {
        return match check(&cfg) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("unhealthy: {e}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(fedimint_receiver::serve(cfg)) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// `GET /health` over plain HTTP/1.1 on the configured address (an unspecified address is asked
/// on loopback).
fn check(cfg: &Config) -> Result<(), String> {
    let mut addr = cfg.listen;
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() { [127, 0, 0, 1].into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("{addr}: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    write!(s, "GET /health HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n", cfg.token)
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let status = buf.lines().next().unwrap_or_default();
    if status.starts_with("HTTP/1.1 200") { Ok(()) } else { Err(format!("{addr} answered {status:?}")) }
}
