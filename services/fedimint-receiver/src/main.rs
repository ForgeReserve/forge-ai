//! `fedimint-receiver`: serve the API (no arguments), or one of:
//!
//! - `healthcheck`: ask a running one for `/health` (the container's health check: the image has
//!   no curl);
//! - `backup [--out FILE]`: write a backup of the data directory (docs/FEDIMINT-RECEIVER.md,
//!   Backup and recovery), safe while the service runs;
//! - `recover [--backup FILE|-] [--invites FILE|-]`: rebuild every federation's wallet from the
//!   seed, with the service stopped;
//! - `restore-done (FEDERATION_ID | --all)`: close a restore once it is reconciled.

use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use fedimint_receiver::config::{self, Config};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "usage: fedimint-receiver [healthcheck | backup [--out FILE] | recover [--backup FILE|-] [--invites FILE|-] | restore-done (FEDERATION_ID | --all)]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => serve(),
        Some("healthcheck") => healthcheck(),
        Some("backup") => run(backup(&args[1..])),
        Some("recover") => run(recover(&args[1..])),
        Some("restore-done") => run(restore_done(&args[1..])),
        Some(_) => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .init();
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime")
}

fn run(r: anyhow::Result<ExitCode>) -> ExitCode {
    r.unwrap_or_else(|e| {
        eprintln!("fedimint-receiver: {e:#}");
        ExitCode::FAILURE
    })
}

fn serve() -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fedimint-receiver: {e:#}");
            return ExitCode::from(2);
        }
    };
    init_logging();
    match runtime().block_on(fedimint_receiver::serve(cfg)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

/// The value after `flag` in `args`, if `flag` is there.
fn option(args: &[String], flag: &str) -> anyhow::Result<Option<String>> {
    match args.iter().position(|a| a == flag) {
        None => Ok(None),
        Some(i) => args.get(i + 1).cloned().map(Some).ok_or_else(|| anyhow::anyhow!("{flag} needs a value\n{USAGE}")),
    }
}

/// Every argument must be one of `flags` followed by its value.
fn only(args: &[String], flags: &[&str]) -> anyhow::Result<()> {
    let mut i = 0;
    while i < args.len() {
        anyhow::ensure!(flags.contains(&args[i].as_str()), "unknown argument {:?}\n{USAGE}", args[i]);
        i += 2;
    }
    Ok(())
}

fn backup(args: &[String]) -> anyhow::Result<ExitCode> {
    only(args, &["--out"])?;
    let out = option(args, "--out")?.map(PathBuf::from);
    let bundle = fedimint_receiver::backup::make(&config::data_dir_from_env())?;
    fedimint_receiver::backup::write(&bundle, out.as_deref())?;
    // The summary goes to standard error, so standard output carries the backup alone.
    eprintln!("{}", serde_json::json!({ "backup": bundle.summary() }));
    Ok(ExitCode::SUCCESS)
}

fn recover(args: &[String]) -> anyhow::Result<ExitCode> {
    only(args, &["--backup", "--invites"])?;
    let backup = option(args, "--backup")?;
    let invites = option(args, "--invites")?;
    anyhow::ensure!(
        !(backup.as_deref() == Some("-") && invites.as_deref() == Some("-")),
        "only one of --backup and --invites can be read from standard input"
    );
    let bundle = backup.as_deref().map(fedimint_receiver::backup::read).transpose()?;
    let invites = match invites.as_deref() {
        None => Vec::new(),
        Some(path) => {
            let mut text = String::new();
            if path == "-" {
                std::io::stdin().read_to_string(&mut text)?;
            } else {
                text = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("reading {path}: {e}"))?;
            }
            // One invite code a line; blank lines and lines starting with # are skipped.
            text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_owned).collect()
        }
    };
    init_logging();
    let mnemonic = config::mnemonic_from_env();
    let lines = runtime().block_on(fedimint_receiver::recover(&config::data_dir_from_env(), mnemonic.as_deref(), bundle, &invites))?;
    let failed = lines.iter().any(|l| l.get("error").is_some());
    let mut stdout = std::io::stdout().lock();
    for l in lines {
        writeln!(stdout, "{l}")?;
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

fn restore_done(args: &[String]) -> anyhow::Result<ExitCode> {
    let which = match args {
        [a] if a == "--all" => None,
        [id] if !id.starts_with('-') => Some(id.as_str()),
        _ => anyhow::bail!("{USAGE}"),
    };
    for l in fedimint_receiver::restore_done(&config::data_dir_from_env(), which)? {
        println!("{l}");
    }
    Ok(ExitCode::SUCCESS)
}

fn healthcheck() -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fedimint-receiver: {e:#}");
            return ExitCode::from(2);
        }
    };
    match check(&cfg) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("unhealthy: {e}");
            ExitCode::FAILURE
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
