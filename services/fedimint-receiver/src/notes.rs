//! Out-of-band notes as the gateway hands them over: read without asking the federation, and
//! named by an id that does not depend on how the string was written.
//!
//! Two kinds are read, by the fedimint module that issued them:
//!
//! - `mint`: mint v1 `OOBNotes`, what `send_oob_notes` prints (base64url, base64 or `fedimint...`
//!   base32), with or without the federation's invite inside. This is what a Fedimint card till's
//!   wallet hands out.
//! - `mintv2`: mintv2 `ECash` (`fedimint...` base32), what a 0.13 federation's default mint hands
//!   out.
//!
//! A parsed value is money: its `Debug` never prints the notes.

use std::fmt;
use std::str::FromStr;

use fedimint_core::base32::{self, FEDIMINT_PREFIX};
use fedimint_core::bitcoin::hashes::{Hash as _, HashEngine as _, sha256};
use fedimint_core::config::{FederationId, FederationIdPrefix};
use fedimint_core::core::OperationId;
use fedimint_core::encoding::Encodable as _;
use fedimint_core::module::AmountUnit;
use fedimint_mint_client::OOBNotes;
use fedimint_mintv2_client::ECash;
use serde::Serialize;

/// The fedimint module kind that issued a set of notes, as fedimint names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum Kind {
    #[serde(rename = "mint")]
    MintV1,
    #[serde(rename = "mintv2")]
    MintV2,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::MintV1 => "mint",
            Kind::MintV2 => "mintv2",
        }
    }
}

#[derive(Clone)]
pub enum Inner {
    V1(OOBNotes),
    V2(ECash),
}

/// A set of notes read from a string.
#[derive(Clone)]
pub struct Notes {
    pub kind: Kind,
    /// The first 4 bytes of the issuing federation's id: all a mint v1 string must carry.
    pub prefix: FederationIdPrefix,
    /// The full federation id, when the string carries it (always for mintv2; for mint v1 only
    /// when the sender included the federation's invite).
    pub federation_id: Option<FederationId>,
    pub amount_msat: u64,
    pub count: usize,
    /// See [`notes_id`].
    pub id: String,
    pub inner: Inner,
}

impl fmt::Debug for Notes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Notes({} {} msat, id {}, <redacted>)", self.kind.as_str(), self.amount_msat, self.id)
    }
}

impl Notes {
    /// The string to keep while a receive is in flight. Re-encoded from the parsed value, so it
    /// decodes back to exactly the notes and fields that were parsed.
    pub fn canonical(&self) -> String {
        match &self.inner {
            Inner::V1(n) => n.to_string(),
            Inner::V2(e) => base32::encode_prefixed(FEDIMINT_PREFIX, e),
        }
    }

    /// The fedimint operation id the receive of these notes runs under. Both modules derive it
    /// from the notes themselves, so it is known before anything is submitted and a second
    /// submission of the same notes finds the first.
    pub fn operation_id(&self) -> OperationId {
        match &self.inner {
            // fedimint-mint-client `reissue_external_notes`: `sha256t::Hash<OOBReissueTag>` of the
            // notes, whose tag starts the hash engine with the bytes "oob-reissue".
            Inner::V1(n) => {
                let mut engine = sha256::HashEngine::default();
                engine.input(b"oob-reissue");
                engine.input(&n.notes().consensus_encode_to_vec());
                OperationId(sha256::Hash::from_engine(engine).to_byte_array())
            }
            // fedimint-mintv2-client `receive`: `OperationId::from_encodable(&ecash)`.
            Inner::V2(e) => OperationId::from_encodable(e),
        }
    }
}

/// Why a string is not a set of notes this service can take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadNotes(pub String);

impl fmt::Display for BadNotes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadNotes {}

fn bad(msg: impl Into<String>) -> BadNotes {
    BadNotes(msg.into())
}

/// The id of a set of notes: SHA-256 over a fixed label, the module kind, the federation id
/// prefix and the notes' nonces in sorted order. The nonces are what the federation marks spent,
/// so the same notes get the same id however the string was encoded, whatever order the notes
/// come in, and whether or not an invite rides along.
pub fn notes_id(kind: Kind, prefix: &FederationIdPrefix, mut nonces: Vec<[u8; 33]>) -> String {
    nonces.sort_unstable();
    let mut engine = sha256::HashEngine::default();
    engine.input(b"forge-fedimint-receiver/notes-id/1\0");
    engine.input(kind.as_str().as_bytes());
    engine.input(b"\0");
    engine.input(&prefix.consensus_encode_to_vec());
    for n in &nonces {
        engine.input(n);
    }
    hex::encode(sha256::Hash::from_engine(engine).to_byte_array())
}

/// Longest string accepted, well above any real token (a note is under 150 bytes encoded).
pub const MAX_LEN: usize = 200_000;

/// Read a notes string of either kind. Whitespace anywhere is ignored, as fedimint's own parsers
/// do, so a string wrapped by a chat or mail client still reads.
pub fn parse(s: &str) -> Result<Notes, BadNotes> {
    if s.len() > MAX_LEN {
        return Err(bad("the notes string is too long"));
    }
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(bad("no notes given"));
    }
    if let Ok(n) = OOBNotes::from_str(&compact) {
        return from_v1(n);
    }
    if let Ok(e) = base32::decode_prefixed::<ECash>(FEDIMINT_PREFIX, &compact) {
        return from_v2(e);
    }
    Err(bad("not Fedimint eCash notes (neither mint v1 nor mintv2)"))
}

fn from_v1(n: OOBNotes) -> Result<Notes, BadNotes> {
    let prefix = n.federation_id_prefix();
    let federation_id = match n.federation_invite() {
        Some(invite) if invite.federation_id().to_prefix() != prefix => {
            return Err(bad("the notes name one federation and carry another federation's invite"));
        }
        Some(invite) => Some(invite.federation_id()),
        None => None,
    };
    let items: Vec<_> = n.notes().iter_items().collect();
    let nonces: Vec<[u8; 33]> = items.iter().map(|(_, note)| note.nonce().0.serialize()).collect();
    let amount_msat = items.iter().try_fold(0u64, |acc, (amount, _)| acc.checked_add(amount.msats));
    let amount_msat = amount_msat.ok_or_else(|| bad("the notes add up to more than any amount"))?;
    check_notes(&nonces, amount_msat)?;
    Ok(Notes {
        kind: Kind::MintV1,
        prefix,
        federation_id,
        amount_msat,
        count: nonces.len(),
        id: notes_id(Kind::MintV1, &prefix, nonces),
        inner: Inner::V1(n),
    })
}

fn from_v2(e: ECash) -> Result<Notes, BadNotes> {
    let federation_id = e.mint().ok_or_else(|| bad("the notes do not name their federation"))?;
    if e.unit() != AmountUnit::BITCOIN {
        return Err(bad("the notes are not denominated in bitcoin"));
    }
    if let Some(invite) = e.federation_invite()
        && invite.federation_id() != federation_id
    {
        return Err(bad("the notes name one federation and carry another federation's invite"));
    }
    let notes = e.notes();
    let nonces: Vec<[u8; 33]> = notes.iter().map(|n| n.keypair.public_key().serialize()).collect();
    let amount_msat = notes.iter().try_fold(0u64, |acc, n| acc.checked_add(n.amount().msats));
    let amount_msat = amount_msat.ok_or_else(|| bad("the notes add up to more than any amount"))?;
    check_notes(&nonces, amount_msat)?;
    let prefix = federation_id.to_prefix();
    Ok(Notes {
        kind: Kind::MintV2,
        prefix,
        federation_id: Some(federation_id),
        amount_msat,
        count: nonces.len(),
        id: notes_id(Kind::MintV2, &prefix, nonces),
        inner: Inner::V2(e),
    })
}

/// No notes, no value, or the same note twice: a string like that can never be received in full,
/// and a repeated note would make the total look larger than the notes are worth.
fn check_notes(nonces: &[[u8; 33]], amount_msat: u64) -> Result<(), BadNotes> {
    if nonces.is_empty() {
        return Err(bad("the string carries no notes"));
    }
    if amount_msat == 0 {
        return Err(bad("the notes are worth nothing"));
    }
    let mut sorted = nonces.to_vec();
    sorted.sort_unstable();
    if sorted.windows(2).any(|w| w[0] == w[1]) {
        return Err(bad("the same note appears twice"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mint v1 token worth 1 sat from fedimint's own test vectors (federation prefix 2a2a2a2a),
    /// as fedimint-sdk's tests use it.
    const V1: &str =
        "AgEEKioqKgBVAf0D6AGl3T66ytG8SL2HGO7VqNodaPkTI77yhIrE-i5vju1xDzF4_UrvBHzCNOaxEnCG8zzECLOYGHgdlSFHU2DeayBfMyjkkKbZnV4lU6RVMgfIvQ==";

    #[test]
    fn reads_a_v1_token_and_its_id_does_not_depend_on_the_encoding() {
        let n = parse(V1).unwrap();
        assert_eq!(n.kind, Kind::MintV1);
        assert_eq!(n.prefix.to_string(), "2a2a2a2a");
        assert_eq!(n.federation_id, None);
        assert_eq!(n.amount_msat, 1_000);
        assert_eq!(n.count, 1);
        assert_eq!(n.id.len(), 64);

        // Wrapped over lines, and re-encoded as base32: the same notes, the same id.
        let wrapped: String =
            V1.chars().collect::<Vec<_>>().chunks(20).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("\n ");
        assert_eq!(parse(&wrapped).unwrap().id, n.id);
        let Inner::V1(oob) = &n.inner else { panic!("v1") };
        let b32 = base32::encode_prefixed(FEDIMINT_PREFIX, oob);
        assert!(b32.starts_with("fedimint"), "{b32:.12}");
        let again = parse(&b32).unwrap();
        assert_eq!(again.kind, Kind::MintV1);
        assert_eq!(again.id, n.id);
        assert_eq!(again.operation_id(), n.operation_id());
        assert_eq!(parse(&n.canonical()).unwrap().id, n.id);
    }

    #[test]
    fn debug_never_prints_the_notes() {
        let n = parse(V1).unwrap();
        let d = format!("{n:?}");
        assert!(!d.contains(&V1[10..40]), "{d}");
        assert!(d.contains("redacted"));
    }

    #[test]
    fn refuses_what_is_not_notes() {
        for s in ["", "   ", "hello", "lnbc1notaninvoice", "fedimint1qqqq", &"A".repeat(MAX_LEN + 1)] {
            assert!(parse(s).is_err(), "{s:.40}");
        }
    }

    #[test]
    fn a_note_given_twice_is_refused() {
        let n = parse(V1).unwrap();
        let Inner::V1(oob) = n.inner else { panic!("v1") };
        let mut doubled = oob.notes().clone();
        let (amount, note) = oob.notes().iter_items().next().map(|(a, n)| (a, *n)).unwrap();
        doubled.push(amount, note);
        let twice = OOBNotes::new(oob.federation_id_prefix(), doubled);
        assert_eq!(parse(&twice.to_string()).unwrap_err(), bad("the same note appears twice"));
    }
}
