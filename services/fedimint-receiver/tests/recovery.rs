//! The recovery drill (docs/FEDIMINT-RECEIVER.md, Backup and recovery): notes are received, the
//! data directory is destroyed, and the wallet comes back from the seed and the federations'
//! invites (`recover --invites`), or from a backup and the seed (`recover --backup`), with the
//! real binary against real in-process federations. Each time the balance must be exactly what it
//! was, the old notes given again must credit nothing, and nothing may end in a way that would
//! make a caller refuse value this wallet holds.

mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::{Value, json};

/// Test vector words: these federations live only in this process.
const WORDS: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC: &str = "FEDIMINT_RECEIVER_MNEMONIC";

async fn receive_done(svc: &Service, notes: &str, key: &str) -> Value {
    let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": key })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let end = svc.settled(r["notes_id"].as_str().unwrap()).await;
    assert_eq!(end["state"], "done", "{end}");
    end
}

/// Give `notes` and wait for the end of the receive.
async fn receive_end(svc: &Service, notes: &str, key: &str) -> Value {
    let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": key })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    svc.settled(r["notes_id"].as_str().unwrap()).await
}

/// The end of a receive the restored wallet cannot decide: the federation calls the notes spent,
/// and this wallet may have spent them itself before its data was lost. Never done (no credit),
/// never `rejected` (a caller would refuse them for good): `issuance_failed`, for an operator.
fn assert_uncertain(end: &Value) {
    assert_eq!((end["state"].as_str(), end["failure"].as_str()), (Some("failed"), Some("issuance_failed")), "{end}");
    assert!(end["reason"].as_str().is_some_and(|r| r.contains("restored from its seed")), "{end}");
}

fn net(r: &Value) -> u64 {
    r["net_msat"].as_u64().expect("net_msat")
}

fn line_for<'a>(lines: &'a [Value], fed: &DevFed) -> &'a Value {
    lines.iter().find(|l| l["federation_id"] == fed.id()).unwrap_or_else(|| panic!("no line for {}: {lines:?}", fed.id()))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_seed_and_the_invites_bring_every_note_back_and_old_notes_credit_nothing() {
    let v1 = fed(Mints::V1).await;
    let v2 = fed(Mints::V2).await;
    let (_t, data) = data_dir();
    let env = [(MNEMONIC, WORDS)];
    let (a, _) = v1.notes(60_000, false, false).await.expect("notes");
    let (c, _) = v2.notes(40_000, true, false).await.expect("notes");
    let (before_v1, before_v2) = {
        let svc = Service::start(&data, &env).await.expect("start");
        svc.join(&v1).await;
        svc.join(&v2).await;
        let ra = receive_done(&svc, &a, "forge:acct-a").await;
        let rc = receive_done(&svc, &c, "forge:acct-c").await;
        let (b1, b2) = (svc.balance(&v1).await, svc.balance(&v2).await);
        assert_eq!((b1, b2), (net(&ra), net(&rc)));
        (b1, b2)
    };

    // The loss: the whole data directory, records and client databases.
    std::fs::remove_dir_all(&data).unwrap();

    // The invites as the gateway exports them: one a line, comments and blank lines allowed.
    let invites = format!("# federations\n{}\n\n{}\n", v1.invite(), v2.invite());
    let out = cli(&data, &env, &["recover", "--invites", "-"], Some(&invites)).await;
    assert!(out.ok, "{}", out.stderr);
    let lines = out.lines();
    for (fed, before) in [(&v1, before_v1), (&v2, before_v2)] {
        let l = line_for(&lines, fed);
        assert_eq!(
            (l["rebuilt"].as_bool(), l["balance_msat"].as_u64(), l["restore_open"].as_bool()),
            (Some(true), Some(before), Some(true)),
            "{l}"
        );
    }
    assert_eq!(lines.last().unwrap()["receives"], 0, "the records went with the directory");
    for text in [&out.stdout, &out.stderr] {
        assert!(!text.contains(&v1.invite()) && !text.contains(&v2.invite()), "an invite was printed");
        assert!(!text.contains("legal winner"), "the words were printed");
    }
    // Run again, it only reports what is there.
    let again = cli(&data, &env, &["recover"], None).await;
    assert!(again.ok, "{}", again.stderr);
    assert_eq!(line_for(&again.lines(), &v1)["rebuilt"], false);

    let svc = Service::start(&data, &env).await.expect("start on the recovered directory");
    assert_eq!((svc.balance(&v1).await, svc.balance(&v2).await), (before_v1, before_v2), "every note is back");
    let (_, list) = svc.get("/federations").await;
    assert!(list["federations"].as_array().unwrap().iter().all(|f| f["restore_open"] == true && f["restored_at"].is_u64()), "{list}");

    // The old notes again, as a gateway's sweep sends notes it still holds: the federation has
    // them spent (by this wallet, before the loss) and nothing here can show who spent them.
    for (notes, key, fed, before) in [(&a, "forge:acct-a", &v1, before_v1), (&c, "forge:acct-c", &v2, before_v2)] {
        let end = receive_end(&svc, notes, key).await;
        assert_uncertain(&end);
        assert_eq!(svc.balance(fed).await, before, "credited nothing");
        let (_, repeat) = svc.post("/receive", json!({ "notes": notes, "key": key })).await;
        assert_eq!((repeat["repeat"].as_bool(), repeat["state"].as_str()), (Some(true), Some("failed")), "{repeat}");
    }

    // New notes go in: the recovered wallet does not reuse a note the federation has seen.
    let (d, _) = v1.notes(30_000, false, false).await.expect("notes");
    let rd = receive_done(&svc, &d, "forge:acct-d").await;
    assert_eq!(svc.balance(&v1).await, before_v1 + net(&rd));
    let (e, _) = v2.notes(30_000, true, false).await.expect("notes");
    let re = receive_done(&svc, &e, "forge:acct-e").await;
    assert_eq!(svc.balance(&v2).await, before_v2 + net(&re));

    // While the restore is open, notes someone else spent are uncertain too...
    let (f, _) = v1.notes(25_000, false, false).await.expect("notes");
    v1.spend(&f).await.expect("spent elsewhere");
    assert_uncertain(&receive_end(&svc, &f, "forge:acct-f").await);
    // ...and once the operator closes it, such notes are rejected again.
    let closed = cli(&data, &[], &["restore-done", "--all"], None).await;
    assert!(closed.ok, "{}", closed.stderr);
    assert!(closed.lines().iter().all(|l| l["closed_now"] == true && l["restore_open"] == false), "{}", closed.stdout);
    let (g, _) = v1.notes(25_000, false, false).await.expect("notes");
    v1.spend(&g).await.expect("spent elsewhere");
    let end = receive_end(&svc, &g, "forge:acct-g").await;
    assert_eq!((end["state"].as_str(), end["failure"].as_str()), (Some("failed"), Some("rejected")), "{end}");
    assert_eq!(svc.balance(&v1).await, before_v1 + net(&rd));
    let (_, list) = svc.get("/federations").await;
    assert!(list["federations"].as_array().unwrap().iter().all(|f| f["restore_open"] == false), "{list}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_backup_and_the_seed_bring_the_records_back_too() {
    let fed = fed(Mints::V1).await;
    let (t, data) = data_dir();
    // A generated seed: the backup is the only copy of its words outside the volume.
    let (a, _) = fed.notes(50_000, false, false).await.expect("notes");
    let ra = {
        let svc = Service::start(&data, &[]).await.expect("start");
        svc.join(&fed).await;
        receive_done(&svc, &a, "forge:acct-a").await
    };
    let words = std::fs::read_to_string(data.join("mnemonic")).unwrap();
    let first_words = words.split_whitespace().take(3).collect::<Vec<_>>().join(" ");

    // A receive cut off between its record and its submission, as a power cut leaves one.
    let (r, _) = fed.notes(35_000, false, false).await.expect("notes");
    let r_id = fedimint_receiver::notes::parse(&r).unwrap().id;
    {
        let mut svc = Service::start(&data, &[("FEDIMINT_RECEIVER_CRASH_AT", "after_persist")]).await.expect("start");
        assert!(svc.try_post("/receive", json!({ "notes": r, "key": "forge:acct-r" })).await.is_err());
        svc.wait_exit();
    }

    // The backup, with the service stopped.
    let b1 = t.path().join("backup-1.json");
    let out = cli(&data, &[], &["backup", "--out", b1.to_str().unwrap()], None).await;
    assert!(out.ok, "{}", out.stderr);
    assert!(out.stdout.is_empty());
    let summary: Value = serde_json::from_str(out.stderr.trim()).unwrap();
    assert_eq!(summary["backup"]["receives"], 2);
    assert_eq!(summary["backup"]["pending"], 1);
    assert_eq!(summary["backup"]["holds_mnemonic"], true);
    assert!(!out.stderr.contains(&first_words), "the words were printed");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&b1).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // A backup file is never overwritten.
    assert!(!cli(&data, &[], &["backup", "--out", b1.to_str().unwrap()], None).await.ok);

    // The loss, and the restore: the records from the backup, the notes from the seed.
    std::fs::remove_dir_all(&data).unwrap();
    let out = cli(&data, &[], &["recover", "--backup", b1.to_str().unwrap()], None).await;
    assert!(out.ok, "{}", out.stderr);
    let lines = out.lines();
    assert_eq!(line_for(&lines, &fed)["balance_msat"].as_u64(), Some(net(&ra)), "the cut off receive never reached the federation");
    assert_eq!((lines.last().unwrap()["receives"].as_u64(), lines.last().unwrap()["pending"].as_u64()), (Some(2), Some(1)));
    assert!(!out.stdout.contains(&first_words) && !out.stderr.contains(&first_words), "the words were printed");
    assert_eq!(std::fs::read_to_string(data.join("mnemonic")).unwrap(), words);

    let svc = Service::start(&data, &[]).await.expect("start on the restored directory");
    // The receive pending in the backup is submitted again; it never reached the federation, so
    // it goes in now.
    let rr = svc.settled(&r_id).await;
    assert_eq!(rr["state"], "done", "{rr}");
    assert_eq!(svc.balance(&fed).await, net(&ra) + net(&rr));
    // A done record came back: the same notes again are a repeat of it, and credit nothing.
    let (_, repeat) = svc.post("/receive", json!({ "notes": a, "key": "forge:acct-a" })).await;
    assert_eq!(
        (repeat["repeat"].as_bool(), repeat["state"].as_str(), repeat["key"].as_str()),
        (Some(true), Some("done"), Some("forge:acct-a"))
    );
    assert_eq!(repeat["net_msat"], ra["net_msat"]);
    assert_eq!(svc.balance(&fed).await, net(&ra) + net(&rr));

    // A backup taken while the service runs.
    let (b, _) = fed.notes(45_000, false, false).await.expect("notes");
    let rb = receive_done(&svc, &b, "forge:acct-b").await;
    let b2 = t.path().join("backup-2.json");
    let out = cli(&data, &[], &["backup", "--out", b2.to_str().unwrap()], None).await;
    assert!(out.ok, "{}", out.stderr);
    let total = svc.balance(&fed).await;
    drop(svc);
    // As if it had read B's record a moment sooner, while that receive was still pending: B
    // then finished before the loss, and the backup does not know.
    let mut bundle: Value = serde_json::from_slice(&std::fs::read(&b2).unwrap()).unwrap();
    let rec = bundle["receives"].as_array_mut().unwrap().iter_mut().find(|r| r["notes_id"] == rb["notes_id"]).unwrap();
    rec["state"] = json!("pending");
    rec["notes"] = json!(fedimint_receiver::notes::parse(&b).unwrap().canonical());
    let b3 = t.path().join("backup-3.json");
    std::fs::write(&b3, serde_json::to_vec(&bundle).unwrap()).unwrap();

    std::fs::remove_dir_all(&data).unwrap();
    let out = cli(&data, &[], &["recover", "--backup", b3.to_str().unwrap()], None).await;
    assert!(out.ok, "{}", out.stderr);
    assert_eq!(line_for(&out.lines(), &fed)["balance_msat"].as_u64(), Some(total), "B's value comes back from the seed");
    // Even with the restore closed, a record older than the restore stays uncertain.
    assert!(cli(&data, &[], &["restore-done", &fed.id()], None).await.ok);
    let svc = Service::start(&data, &[]).await.expect("start");
    assert_uncertain(&svc.settled(rb["notes_id"].as_str().unwrap()).await);
    assert_eq!(svc.balance(&fed).await, total, "credited nothing twice");
    // The rest of the records are as they were.
    assert_eq!(svc.settled(&r_id).await["state"], "done");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_join_with_a_seed_that_already_holds_notes_recovers_them() {
    // The operator starts over on an empty volume with the same words and joins again, instead of
    // running recover: the join runs Fedimint's recovery all the same, to its end even when its
    // caller stops waiting.
    let fed = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let env = [(MNEMONIC, WORDS)];
    let (a, _) = fed.notes(40_000, false, false).await.expect("notes");
    let before = {
        let svc = Service::start(&data, &env).await.expect("start");
        let j = svc.join(&fed).await;
        assert_eq!((j["restored_at"].as_u64(), j["restore_open"].as_bool()), (None, Some(false)), "a first join restores nothing: {j}");
        net(&receive_done(&svc, &a, "forge:acct-a").await)
    };
    std::fs::remove_dir_all(&data).unwrap();
    let svc = Service::start(&data, &env).await.expect("start");
    // A caller that gives up first (the gateway's client waits 15 s; a long history takes longer):
    // the join goes on, and is there when asked again.
    let gave_up = reqwest::Client::new()
        .post(format!("{}/federations", svc.url))
        .bearer_auth(TOKEN)
        .json(&json!({ "invite": fed.invite() }))
        .timeout(std::time::Duration::from_millis(200))
        .send()
        .await;
    assert!(gave_up.is_err(), "the recovery answered within 200 ms");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while svc.get("/federations").await.1["federations"].as_array().is_none_or(Vec::is_empty) {
        assert!(std::time::Instant::now() < deadline, "the join did not go on without its caller");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let j = svc.join(&fed).await;
    assert_eq!((j["already_joined"].as_bool(), j["restore_open"].as_bool()), (Some(true), Some(true)), "{j}");
    assert_eq!(svc.balance(&fed).await, before);
    assert_uncertain(&receive_end(&svc, &a, "forge:acct-a").await);
    let (d, _) = fed.notes(30_000, false, false).await.expect("notes");
    let rd = receive_done(&svc, &d, "forge:acct-d").await;
    assert_eq!(svc.balance(&fed).await, before + net(&rd));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_recovery_commands_refuse_what_could_lose_track_of_value() {
    let (t, data) = data_dir();
    // No seed at all: recover makes no new one.
    let out = cli(&data, &[], &["recover"], None).await;
    assert!(!out.ok && out.stderr.contains("needs the wallet's words"), "{}", out.stderr);
    assert!(!data.join("mnemonic").exists());
    // Not an invite.
    let out = cli(&data, &[(MNEMONIC, WORDS)], &["recover", "--invites", "-"], Some("not an invite\n")).await;
    assert!(!out.ok && out.stderr.contains("not a Fedimint invite code"), "{}", out.stderr);

    // One process at a time on a data directory.
    let svc = Service::start(&data, &[(MNEMONIC, WORDS)]).await.expect("start");
    let err = Service::start(&data, &[(MNEMONIC, WORDS)]).await.err().expect("a second service is refused");
    assert!(err.contains("another fedimint-receiver process"), "{err}");
    let out = cli(&data, &[(MNEMONIC, WORDS)], &["recover"], None).await;
    assert!(!out.ok && out.stderr.contains("another fedimint-receiver process"), "{}", out.stderr);
    // A backup is fine while the service runs, here to standard output (a pipe).
    let out = cli(&data, &[], &["backup"], None).await;
    assert!(out.ok, "{}", out.stderr);
    let bundle: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(bundle["format"], "forge-fedimint-receiver-backup/1");
    assert!(bundle.get("mnemonic").is_none(), "words from the environment are not in a backup");
    drop(svc);

    // A backup goes only into an empty directory.
    let file = t.path().join("backup.json");
    std::fs::write(&file, &out.stdout).unwrap();
    let out = cli(&data, &[(MNEMONIC, WORDS)], &["recover", "--backup", file.to_str().unwrap()], None).await;
    assert!(!out.ok && out.stderr.contains("not empty"), "{}", out.stderr);
    // Into an empty one, with other words than its own: refused.
    let (_t2, other) = data_dir();
    let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let out = cli(&other, &[(MNEMONIC, words)], &["recover", "--backup", file.to_str().unwrap()], None).await;
    assert!(!out.ok && out.stderr.contains("not the one the data directory was made with"), "{}", out.stderr);

    // Closing the restore of a federation that is not joined.
    let out = cli(&data, &[], &["restore-done", "0000"], None).await;
    assert!(!out.ok);
    // A backup of what is not a data directory.
    assert!(!cli(&t.path().join("nothing"), &[], &["backup"], None).await.ok);
}
