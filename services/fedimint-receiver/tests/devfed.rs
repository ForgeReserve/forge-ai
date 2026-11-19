//! The `devfed` binary as the gateway's end to end tests will use it: started as a process, its
//! invite read from its first line, notes asked over HTTP and received by the real receiver.

mod common;

use std::io::{BufRead as _, BufReader};
use std::process::{Command, Stdio};

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn devfed_hands_out_notes_the_receiver_takes() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_devfed"))
        .args(["--mints", "mint"])
        .env("RUST_LOG", "warn")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn devfed");
    let stdout = child.stdout.take().unwrap();
    let line = tokio::task::spawn_blocking(move || {
        let mut l = String::new();
        BufReader::new(stdout).read_line(&mut l).map(|_| l)
    })
    .await
    .unwrap()
    .unwrap();
    let info: Value = serde_json::from_str(&line).expect("one JSON line");
    let url = info["url"].as_str().unwrap().to_owned();
    let http = reqwest::Client::new();

    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    let (s, j) = svc.post("/federations", json!({ "invite": info["invite"] })).await;
    assert_eq!(s, StatusCode::OK, "{j}");
    assert_eq!(j["id"], info["federation_id"]);

    let n: Value = http.post(format!("{url}/notes")).json(&json!({ "amount_msat": 10_000 })).send().await.unwrap().json().await.unwrap();
    let (s, r) = svc.post("/receive", json!({ "notes": n["notes"], "key": "devfed" })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let done = svc.settled(r["notes_id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "done", "{done}");
    assert_eq!(done["gross_msat"], n["amount_msat"]);

    // /spend makes notes that nobody else can take.
    let n2: Value = http.post(format!("{url}/notes")).json(&json!({ "amount_msat": 10_000 })).send().await.unwrap().json().await.unwrap();
    let spent = http.post(format!("{url}/spend")).json(&json!({ "notes": n2["notes"] })).send().await.unwrap();
    assert!(spent.status().is_success());
    let (_, r2) = svc.post("/receive", json!({ "notes": n2["notes"], "key": "devfed-2" })).await;
    assert_eq!(svc.settled(r2["notes_id"].as_str().unwrap()).await["state"], "failed");

    let _ = child.kill();
    let _ = child.wait();
}
