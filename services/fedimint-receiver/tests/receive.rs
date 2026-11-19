//! The receiver's HTTP API end to end, against real in-process federations (four guardians each,
//! fake bitcoin; see src/devfed.rs). Notes come from a separate client of the federation, made the
//! way a wallet makes them: mint v1 `send_oob_notes` (what a Fedimint card till's wallet calls) or
//! mintv2 `send`. Nothing here reaches a real federation or real money.

mod common;

use common::*;
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn every_route_needs_the_bearer_token() {
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    let routes = [
        (Method::GET, "/health"),
        (Method::GET, "/federations"),
        (Method::POST, "/federations"),
        (Method::GET, "/federations/00/balance"),
        (Method::POST, "/parse"),
        (Method::POST, "/receive"),
        (Method::GET, "/receive/00"),
        (Method::GET, "/no-such-route"),
    ];
    for (m, path) in routes {
        for token in [None, Some("wrong"), Some(&TOKEN[..TOKEN.len() - 1])] {
            let (s, v) = svc.request(m.clone(), path, Some(json!({})), token).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{m} {path} with {token:?}");
            assert_eq!(v["error"]["code"], "unauthorized");
        }
    }
    let (s, v) = svc.get("/health").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["ok"], true);
    assert_eq!(v["federations"], 0);
    // A missing token refuses to start, as does a short one.
    let (_t2, data2) = data_dir();
    assert!(Service::start(&data2, &[("FEDIMINT_RECEIVER_TOKEN", "short")]).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn joins_by_invite_once_and_receives_mint_v1_notes_for_their_net_value_once() {
    let fed = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");

    // Join, and join again: the same federation, no second join.
    let j = svc.join(&fed).await;
    assert_eq!(j["id"], fed.id());
    assert_eq!(j["already_joined"], false);
    assert_eq!(j["receives"], json!(["mint"]));
    let again = svc.join(&fed).await;
    assert_eq!(again["id"], fed.id());
    assert_eq!(again["already_joined"], true);
    let (s, v) = svc.post("/federations", json!({ "invite": "not an invite" })).await;
    assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("bad_invite")));
    let (_, list) = svc.get("/federations").await;
    assert_eq!(list["federations"].as_array().map(Vec::len), Some(1));
    assert_eq!(list["federations"][0]["balance_msat"], 0);

    // Notes from another client of the federation, as the till's wallet makes them.
    let (notes, value) = fed.notes(50_000, false, false).await.expect("notes");
    assert!(value >= 50_000);
    let (s, p) = svc.post("/parse", json!({ "notes": notes })).await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!(p["module"], "mint");
    assert_eq!(p["amount_msat"], value);
    assert_eq!(p["joined"], true);
    assert_eq!(p["resolution"], "joined");
    assert_eq!(p["federation_id"], fed.id());
    assert_eq!(p["signatures_valid"], true);
    assert_eq!(p["received"], json!(null));
    let notes_id = p["notes_id"].as_str().expect("notes_id").to_owned();

    let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": "acct-1:topup-1" })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["notes_id"], notes_id);
    assert_eq!(r["repeat"], false);
    assert_eq!(r["gross_msat"], value);
    assert!(r.get("notes").is_none(), "the record never shows the notes");
    let done = svc.settled(&notes_id).await;
    assert_eq!(done["state"], "done", "{done}");
    let (gross, fee, net) = (done["gross_msat"].as_u64().unwrap(), done["fee_msat"].as_u64().unwrap(), done["net_msat"].as_u64().unwrap());
    assert_eq!(gross, value);
    assert!(fee > 0, "the test federation charges fees: {done}");
    assert_eq!(net, gross - fee);
    assert_eq!(svc.balance(&fed).await, net, "the balance rose by exactly net");
    assert_eq!(done["operation_id"], r["operation_id"]);

    // The same notes again, with another key and as another encoding (with the invite inside):
    // the same record, the first key, no second credit.
    let with_invite = {
        let parsed = fedimint_receiver::notes::parse(&notes).unwrap();
        let fedimint_receiver::notes::Inner::V1(oob) = parsed.inner else { panic!("v1") };
        let invite: fedimint_core::invite_code::InviteCode = fed.invite().parse().unwrap();
        fedimint_mint_client::OOBNotes::new_with_invite(oob.notes().clone(), &invite).to_string()
    };
    assert_ne!(with_invite, notes);
    for (text, key) in [(&notes, "acct-1:topup-1"), (&notes, "acct-2:other"), (&with_invite, "acct-3:x")] {
        let (s, again) = svc.post("/receive", json!({ "notes": text, "key": key })).await;
        assert_eq!(s, StatusCode::OK, "{again}");
        assert_eq!(again["repeat"], true);
        assert_eq!(again["notes_id"], notes_id);
        assert_eq!(again["key"], "acct-1:topup-1");
        assert_eq!(again["state"], "done");
        assert_eq!(again["net_msat"], net);
        assert_eq!(again["operation_id"], done["operation_id"]);
    }
    let (_, p2) = svc.post("/parse", json!({ "notes": with_invite })).await;
    assert_eq!(p2["notes_id"], notes_id);
    assert_eq!(p2["received"], "done");
    assert_eq!(svc.balance(&fed).await, net);

    // Bad input is refused with stable codes.
    let (s, v) = svc.post("/receive", json!({ "notes": notes, "key": "" })).await;
    assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")));
    let (s, v) = svc.post("/receive", json!({ "notes": "hello", "key": "k" })).await;
    assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("bad_notes")));
    let (s, v) = svc.post("/parse", json!({ "nope": 1 })).await;
    assert_eq!((s, v["error"]["code"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")));
    let (s, _) = svc.get(&format!("/receive/{}", "0".repeat(64))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Nothing secret reached the log, and the operation ran under the id recorded before it was
    // submitted.
    let log = svc.log_text();
    assert!(!log.contains(&notes[..40]) && !log.contains(&with_invite[..40]), "notes in the log");
    assert!(!log.contains("instead of"), "the operation id was not the one recorded");
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_spent_elsewhere_end_failed_and_credit_nothing() {
    let fed = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    svc.join(&fed).await;
    let (notes, _) = fed.notes(30_000, false, false).await.expect("notes");
    // Another wallet takes them first.
    fed.spend(&notes).await.expect("spent elsewhere");
    let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": "k1" })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let end = svc.settled(r["notes_id"].as_str().unwrap()).await;
    assert_eq!(end["state"], "failed", "{end}");
    assert_eq!(end["failure"], "rejected", "{end}");
    assert!(end["reason"].as_str().is_some_and(|r| !r.is_empty()), "{end}");
    assert_eq!(svc.balance(&fed).await, 0);
    // Asking again gives the same failed record; nothing is tried twice.
    let (_, again) = svc.post("/receive", json!({ "notes": notes, "key": "k2" })).await;
    assert_eq!((again["state"].as_str(), again["repeat"].as_bool(), again["key"].as_str()), (Some("failed"), Some(true), Some("k1")));
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_of_a_federation_not_joined_are_refused_and_left_unspent() {
    let joined = fed(Mints::V1).await;
    let other = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    svc.join(&joined).await;
    for include_invite in [false, true] {
        let (notes, value) = other.notes(20_000, false, include_invite).await.expect("notes");
        let (s, p) = svc.post("/parse", json!({ "notes": notes })).await;
        assert_eq!(s, StatusCode::OK, "{p}");
        assert_eq!(p["joined"], false);
        assert_eq!(p["resolution"], "not_joined");
        assert_eq!(p["amount_msat"], value);
        assert_eq!(p["federation_prefix"], other.id()[..8]);
        // The full id only when the notes carry the invite.
        assert_eq!(p["federation_id"].as_str(), include_invite.then(|| other.id()).as_deref());
        let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": "k" })).await;
        assert_eq!((s, r["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("not_joined")), "{r}");
        let (s, _) = svc.get(&format!("/receive/{}", p["notes_id"].as_str().unwrap())).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "nothing was recorded");
        // Nothing was spent: the notes still go to another wallet.
        other.spend(&notes).await.expect("the notes are still good");
    }
    assert_eq!(svc.balance(&joined).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_whose_signatures_do_not_verify_are_refused_before_anything_is_recorded() {
    let joined = fed(Mints::V1).await;
    let other = fed(Mints::V1).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    svc.join(&joined).await;
    // Real notes of another federation, relabelled with the joined federation's prefix.
    let (notes, _) = other.notes(20_000, false, false).await.expect("notes");
    let fedimint_receiver::notes::Inner::V1(oob) = fedimint_receiver::notes::parse(&notes).unwrap().inner else { panic!("v1") };
    let joined_id: fedimint_core::config::FederationId = joined.id().parse().unwrap();
    let forged = fedimint_mint_client::OOBNotes::new(joined_id.to_prefix(), oob.notes().clone()).to_string();
    let (s, p) = svc.post("/parse", json!({ "notes": forged })).await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!((p["joined"].as_bool(), p["signatures_valid"].as_bool()), (Some(true), Some(false)));
    let (s, r) = svc.post("/receive", json!({ "notes": forged, "key": "k" })).await;
    assert_eq!((s, r["error"]["code"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("bad_notes")), "{r}");
    let (s, _) = svc.get(&format!("/receive/{}", p["notes_id"].as_str().unwrap())).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    other.spend(&notes).await.expect("the real notes are untouched");
}

#[tokio::test(flavor = "multi_thread")]
async fn mintv2_notes_are_received_once() {
    let fed = fed(Mints::V2).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    let j = svc.join(&fed).await;
    assert_eq!(j["receives"], json!(["mintv2"]));
    let (notes, value) = fed.notes(40_000, true, false).await.expect("notes");
    let (_, p) = svc.post("/parse", json!({ "notes": notes })).await;
    assert_eq!((p["module"].as_str(), p["joined"].as_bool(), p["signatures_valid"].as_bool()), (Some("mintv2"), Some(true), Some(true)));
    assert_eq!(p["federation_id"], fed.id());
    let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": "v2" })).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let done = svc.settled(r["notes_id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "done", "{done}");
    assert_eq!(done["gross_msat"], value);
    let net = done["net_msat"].as_u64().unwrap();
    assert_eq!(net, value - done["fee_msat"].as_u64().unwrap());
    assert_eq!(svc.balance(&fed).await, net);
    let (_, again) = svc.post("/receive", json!({ "notes": notes, "key": "other" })).await;
    assert_eq!((again["repeat"].as_bool(), again["state"].as_str(), again["key"].as_str()), (Some(true), Some("done"), Some("v2")));
    assert_eq!(svc.balance(&fed).await, net);
    // Spent by this wallet: another wallet can no longer take them.
    assert!(fed.spend(&notes).await.is_err());
    assert!(!svc.log_text().contains("instead of"), "the operation id was not the one recorded");
}

#[tokio::test(flavor = "multi_thread")]
async fn two_federations_at_once_keep_their_own_balances() {
    let a = fed(Mints::V1).await;
    let b = fed(Mints::V2).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    svc.join(&a).await;
    svc.join(&b).await;
    let (na, _) = a.notes(25_000, false, false).await.expect("notes a");
    let (nb, _) = b.notes(60_000, true, false).await.expect("notes b");
    let (_, ra) = svc.post("/receive", json!({ "notes": na, "key": "a" })).await;
    let (_, rb) = svc.post("/receive", json!({ "notes": nb, "key": "b" })).await;
    let da = svc.settled(ra["notes_id"].as_str().unwrap()).await;
    let db = svc.settled(rb["notes_id"].as_str().unwrap()).await;
    assert_eq!((da["state"].as_str(), db["state"].as_str()), (Some("done"), Some("done")));
    assert_eq!(da["federation_id"], a.id());
    assert_eq!(db["federation_id"], b.id());
    assert_eq!(svc.balance(&a).await, da["net_msat"].as_u64().unwrap());
    assert_eq!(svc.balance(&b).await, db["net_msat"].as_u64().unwrap());
    let (_, list) = svc.get("/federations").await;
    let feds = list["federations"].as_array().unwrap();
    assert_eq!(feds.len(), 2);
    for f in feds {
        let want = if f["id"] == a.id() { &da } else { &db };
        assert_eq!(f["balance_msat"], want["net_msat"]);
    }
    let (_, h) = svc.get("/health").await;
    assert_eq!(h["federations"], 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_federation_with_both_mints_receives_both_kinds_of_notes() {
    let fed = fed(Mints::Both).await;
    let (_t, data) = data_dir();
    let svc = Service::start(&data, &[]).await.expect("start");
    let j = svc.join(&fed).await;
    assert_eq!(j["receives"], json!(["mint", "mintv2"]));
    let mut total = 0;
    for v2 in [false, true] {
        let (notes, _) = fed.notes(30_000, v2, false).await.expect("notes");
        let (s, r) = svc.post("/receive", json!({ "notes": notes, "key": format!("both-{v2}") })).await;
        assert_eq!(s, StatusCode::OK, "{r}");
        let done = svc.settled(r["notes_id"].as_str().unwrap()).await;
        assert_eq!(done["state"], "done", "{done}");
        assert_eq!(done["module"], if v2 { "mintv2" } else { "mint" });
        total += done["net_msat"].as_u64().unwrap();
        assert_eq!(svc.balance(&fed).await, total, "the balance counts both mints");
    }
}
