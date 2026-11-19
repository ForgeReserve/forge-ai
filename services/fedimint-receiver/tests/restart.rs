//! Restarts: the receiver is stopped hard at each point of a receive (a crash point that aborts
//! the process, or SIGKILL) and started again on the same data directory. Every receive must end
//! `done` exactly once: one record, one operation, the balance up by `net` once, and the notes
//! spent (no other wallet can take them). Also the seed's rules across restarts.

mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;

/// Receive notes with the process set to abort at `crash_at`, restart it, and check the receive
/// completes exactly once.
async fn receive_across_a_crash(crash_at: &str, resumed_as: &str) {
    let fed = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    {
        let svc = Service::start(&data, &[]).await.expect("start");
        svc.join(&fed).await;
    }
    let (notes, value) = fed.notes(70_000, false, false).await.expect("notes");
    let notes_id = fedimint_receiver::notes::parse(&notes).unwrap().id;

    let mut svc = Service::start(&data, &[("FEDIMINT_RECEIVER_CRASH_AT", crash_at)]).await.expect("start");
    assert!(
        svc.try_post("/receive", json!({ "notes": notes, "key": "first" })).await.is_err(),
        "the process answered instead of crashing at {crash_at}"
    );
    let status = svc.wait_exit();
    assert!(!status.success(), "{crash_at}: {status:?}");
    drop(svc);

    let svc = Service::start(&data, &[]).await.expect("restart");
    let done = svc.settled(&notes_id).await;
    assert_eq!(done["state"], "done", "{crash_at}: {done}");
    assert!(svc.log_text().contains(resumed_as), "{crash_at}: the restart did not {resumed_as:?}");
    assert_eq!(done["key"], "first");
    assert_eq!(done["gross_msat"], value);
    let net = done["net_msat"].as_u64().unwrap();
    assert_eq!(svc.balance(&fed).await, net, "{crash_at}: credited once");
    let (_, again) = svc.post("/receive", json!({ "notes": notes, "key": "second" })).await;
    assert_eq!((again["repeat"].as_bool(), again["operation_id"].clone()), (Some(true), done["operation_id"].clone()));
    assert!(fed.spend(&notes).await.is_err(), "{crash_at}: the notes are spent");
    // Once more from the top: still once.
    drop(svc);
    let svc = Service::start(&data, &[]).await.expect("restart again");
    assert_eq!(svc.balance(&fed).await, net);
    assert_eq!(svc.settled(&notes_id).await["state"], "done");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_after_the_record_is_written_and_before_the_notes_are_submitted() {
    receive_across_a_crash("after_persist", "submitting a receive that was recorded before a restart").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_after_the_notes_are_submitted_and_before_the_answer() {
    receive_across_a_crash("after_submit", "following a receive started before a restart").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kill_right_after_a_pending_answer_and_while_the_federation_works() {
    for v2 in [false, true] {
        let fed = fed(if v2 { Mints::V2 } else { Mints::V1 }).await;
        let (_t, data) = data_dir();
        let mut svc = Service::start(&data, &[]).await.expect("start");
        svc.join(&fed).await;
        let (notes, _) = fed.notes(45_000, v2, false).await.expect("notes");
        let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": "k" })).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        // The answer comes as soon as the notes are submitted; the federation may or may not
        // have finished by the kill, and either way the receive must end once.
        assert_eq!(r["state"], "pending");
        svc.kill();
        drop(svc);
        let svc = Service::start(&data, &[]).await.expect("restart");
        let done = svc.settled(r["notes_id"].as_str().unwrap()).await;
        assert_eq!(done["state"], "done", "{done}");
        assert_eq!(done["operation_id"], r["operation_id"]);
        assert_eq!(svc.balance(&fed).await, done["net_msat"].as_u64().unwrap());
        assert!(fed.spend(&notes).await.is_err());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_seed_from_the_environment_is_never_written_and_never_swapped() {
    let fed = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let other = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    let net = {
        let svc = Service::start(&data, &[("FEDIMINT_RECEIVER_MNEMONIC", words)]).await.expect("start");
        svc.join(&fed).await;
        let (notes, _) = fed.notes(20_000, false, false).await.expect("notes");
        let (_, r) = svc.post("/receive", json!({ "notes": notes, "key": "k" })).await;
        svc.settled(r["notes_id"].as_str().unwrap()).await["net_msat"].as_u64().unwrap()
    };
    assert!(!data.join("mnemonic").exists(), "an env seed is never written");
    // Another seed, or none, does not open this directory.
    let err = Service::start(&data, &[("FEDIMINT_RECEIVER_MNEMONIC", other)]).await.err().expect("refused");
    assert!(err.contains("not the one the data directory was made with"), "{err}");
    let err = Service::start(&data, &[]).await.err().expect("refused");
    assert!(err.contains("set it again"), "{err}");
    assert!(!data.join("mnemonic").exists());
    // The right one does, with the balance where it was.
    let svc = Service::start(&data, &[("FEDIMINT_RECEIVER_MNEMONIC", words)]).await.expect("restart");
    assert_eq!(svc.balance(&fed).await, net);
    let log = svc.log_text();
    assert!(!log.contains("abandon abandon") && !log.contains("legal winner"), "the mnemonic reached the log");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_generated_seed_is_kept_private_in_the_data_directory() {
    let (_t, data) = data_dir();
    drop(Service::start(&data, &[]).await.expect("start"));
    let m = data.join("mnemonic");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&m).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&data).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let words = std::fs::read_to_string(&m).unwrap();
    assert_eq!(words.split_whitespace().count(), 12);
    let svc = Service::start(&data, &[]).await.expect("restart");
    assert_eq!(std::fs::read_to_string(&m).unwrap(), words, "kept, not regenerated");
    let first = words.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
    assert!(!svc.log_text().contains(&first), "the mnemonic reached the log");
}
