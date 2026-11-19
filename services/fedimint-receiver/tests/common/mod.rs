//! The receiver as the gateway will run it: its real binary in a child process, spoken to over
//! HTTP, against federations of four guardians started in the test process (devfed.rs). A
//! restart is a real one: the child is killed (SIGKILL, or an abort at a crash point) and a new
//! process opens the same data directory.

#![allow(dead_code)]

use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub use fedimint_receiver::devfed::{DevFed, Mints};
use reqwest::StatusCode;
use serde_json::{Value, json};

pub const TOKEN: &str = "test-token-0123456789abcdef0123456789";

pub struct Service {
    child: Option<Child>,
    pub url: String,
    pub data: PathBuf,
    pub log: PathBuf,
    http: reqwest::Client,
}

impl Service {
    /// Start the receiver on `data` with `env` on top of the test defaults. Returns once it
    /// listens, or the error output when it exits first.
    pub async fn start(data: &Path, env: &[(&str, &str)]) -> Result<Service, String> {
        let log = data.with_extension("log");
        let stderr = std::fs::OpenOptions::new().create(true).append(true).open(&log).expect("log file");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_fedimint-receiver"));
        cmd.env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("FEDIMINT_RECEIVER_TOKEN", TOKEN)
            .env("FEDIMINT_RECEIVER_LISTEN", "127.0.0.1:0")
            .env("FEDIMINT_RECEIVER_DATA_DIR", data)
            .env("RUST_LOG", "info,fedimint_receiver=debug")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(stderr);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn fedimint-receiver");
        let stdout = child.stdout.take().expect("stdout");
        let line = tokio::task::spawn_blocking(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).map(|_| line)
        });
        let line = match tokio::time::timeout(Duration::from_secs(60), line).await {
            Ok(Ok(Ok(l))) if !l.is_empty() => l,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::fs::read_to_string(&log).unwrap_or_default());
            }
        };
        let v: Value = serde_json::from_str(&line).expect("the first stdout line is JSON");
        let url = format!("http://{}", v["listening"].as_str().expect("listening"));
        Ok(Service { child: Some(child), url, data: data.to_path_buf(), log, http: reqwest::Client::new() })
    }

    /// SIGKILL: nothing is flushed, nothing is closed.
    pub fn kill(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// Wait for a process that aborts by itself (a crash point).
    pub fn wait_exit(&mut self) -> std::process::ExitStatus {
        let mut c = self.child.take().expect("running");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(s) = c.try_wait().expect("wait") {
                return s;
            }
            assert!(Instant::now() < deadline, "the receiver did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub async fn request(&self, method: reqwest::Method, path: &str, body: Option<Value>, token: Option<&str>) -> (StatusCode, Value) {
        let mut req = self.http.request(method, format!("{}{path}", self.url)).timeout(Duration::from_secs(90));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap_or_else(|e| panic!("{path}: {e}"));
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    /// `POST`, where the process may die before it answers.
    pub async fn try_post(&self, path: &str, body: Value) -> Result<(StatusCode, Value), reqwest::Error> {
        let res =
            self.http.post(format!("{}{path}", self.url)).bearer_auth(TOKEN).json(&body).timeout(Duration::from_secs(90)).send().await?;
        let status = res.status();
        Ok((status, res.json().await?))
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.request(reqwest::Method::GET, path, None, Some(TOKEN)).await
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.request(reqwest::Method::POST, path, Some(body), Some(TOKEN)).await
    }

    pub async fn join(&self, fed: &DevFed) -> Value {
        let (s, v) = self.post("/federations", json!({ "invite": fed.invite() })).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }

    pub async fn balance(&self, fed: &DevFed) -> u64 {
        let (s, v) = self.get(&format!("/federations/{}/balance", fed.id())).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v["balance_msat"].as_u64().expect("balance_msat")
    }

    /// Poll `GET /receive/{id}` until it leaves `pending`.
    pub async fn settled(&self, notes_id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let (s, v) = self.get(&format!("/receive/{notes_id}")).await;
            assert_eq!(s, StatusCode::OK, "{v}");
            if v["state"] != "pending" {
                return v;
            }
            assert!(Instant::now() < deadline, "the receive is still pending: {v}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.kill();
        if std::thread::panicking() {
            let log = self.log_text();
            let tail: Vec<&str> = log.lines().rev().take(60).collect();
            eprintln!("--- receiver log (last lines) ---\n{}", tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
        }
    }
}

/// A fresh data directory (and its log file beside it) that lives as long as the guard.
pub fn data_dir() -> (tempfile::TempDir, PathBuf) {
    let t = tempfile::tempdir().expect("tempdir");
    let d = t.path().join("data");
    (t, d)
}

pub async fn fed(mints: Mints) -> DevFed {
    DevFed::start(mints, true).await.expect("federation")
}
