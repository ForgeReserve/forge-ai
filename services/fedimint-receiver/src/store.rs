//! The service's own small state, next to the fedimint client databases:
//!
//! ```text
//! <data>/
//!   mnemonic                   only when the seed was generated here (mode 0600)
//!   seed-check                 fingerprint of the seed (seed.rs)
//!   federations/<id>/
//!     federation.json          the invite it was joined with, its name, when
//!     client.db/               the fedimint client's RocksDB
//!   receives/<notes_id>.json   one record per set of notes received
//! ```
//!
//! Each file is written whole: to a temporary file, synced, then renamed over the old one, so a
//! crash leaves the old version or the new one, never half of either. Directories and files are
//! private to the service's user.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::notes::Kind;

pub fn create_private_dir(path: &Path) -> Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        b.mode(0o700);
    }
    b.create(path).with_context(|| format!("creating {}", path.display()))
}

fn private_options() -> std::fs::OpenOptions {
    let mut o = std::fs::OpenOptions::new();
    o.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        o.mode(0o600);
    }
    o
}

/// Write `bytes` to a file that must not exist yet.
pub fn write_new_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = private_options().create_new(true).open(path).with_context(|| format!("creating {}", path.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    sync_dir(path);
    Ok(())
}

/// Replace `path` with `bytes` in one step.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = private_options().create(true).truncate(true).open(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    sync_dir(path);
    Ok(())
}

/// Make a rename durable: sync the directory that holds `path` (best effort; not every
/// filesystem allows it).
fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent()
        && let Ok(d) = std::fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Done,
    Failed,
}

/// One set of notes this service was asked to receive. Written before anything is submitted to
/// the federation; `notes` is kept only while the receive is pending (it is what a restart
/// submits again if the first submission never happened) and is cleared once the receive ends.
#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiveRecord {
    pub notes_id: String,
    /// The caller's key from the request that started the receive. A repeat with another key gets
    /// this record back unchanged, so the caller can tell its own receive from someone else's.
    pub key: String,
    pub federation_id: String,
    pub module: Kind,
    pub operation_id: String,
    pub state: State,
    /// Face value of the notes.
    pub gross_msat: u64,
    /// The federation's fee for the reissue: quoted while pending, as charged once done.
    pub fee_msat: u64,
    /// `gross_msat - fee_msat`: what the wallet's balance rose by once `done`.
    pub net_msat: u64,
    /// Set when `failed`: `rejected` (the federation refused the notes: spent already, or
    /// invalid), `refused` (this wallet refused to submit them) or `issuance_failed` (accepted,
    /// but the new notes could not be issued; needs an operator).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl std::fmt::Debug for ReceiveRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceiveRecord")
            .field("notes_id", &self.notes_id)
            .field("federation_id", &self.federation_id)
            .field("module", &self.module)
            .field("state", &self.state)
            .field("gross_msat", &self.gross_msat)
            .field("notes", &self.notes.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// Seconds since the Unix epoch.
pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// What `federation.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationFile {
    pub id: String,
    pub invite: String,
    #[serde(default)]
    pub name: Option<String>,
    pub joined_at: u64,
}

#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        create_private_dir(dir)?;
        create_private_dir(&dir.join("federations"))?;
        create_private_dir(&dir.join("receives"))?;
        Ok(Self { dir: dir.to_path_buf() })
    }

    pub fn federation_dir(&self, id: &str) -> PathBuf {
        self.dir.join("federations").join(id)
    }

    /// Every federation joined, by their `federation.json`.
    pub fn federations(&self) -> Result<Vec<FederationFile>> {
        let mut out: Vec<FederationFile> = Vec::new();
        for entry in std::fs::read_dir(self.dir.join("federations"))? {
            let path = entry?.path().join("federation.json");
            match std::fs::read(&path) {
                Ok(bytes) => out.push(serde_json::from_slice(&bytes).with_context(|| format!("reading {}", path.display()))?),
                // A directory without the file is a join that never finished: not joined.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
            }
        }
        out.sort_by_key(|f| f.joined_at);
        Ok(out)
    }

    pub fn save_federation(&self, f: &FederationFile) -> Result<()> {
        write_atomic(&self.federation_dir(&f.id).join("federation.json"), &serde_json::to_vec_pretty(f)?)
    }

    fn receive_path(&self, notes_id: &str) -> PathBuf {
        self.dir.join("receives").join(format!("{notes_id}.json"))
    }

    pub fn receive(&self, notes_id: &str) -> Result<Option<ReceiveRecord>> {
        if notes_id.len() != 64 || !notes_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Ok(None);
        }
        match std::fs::read(self.receive_path(notes_id)) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).context("reading a receive record")?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).context("reading a receive record"),
        }
    }

    pub fn save_receive(&self, r: &ReceiveRecord) -> Result<()> {
        write_atomic(&self.receive_path(&r.notes_id), &serde_json::to_vec(r)?)
    }

    pub fn pending_receives(&self) -> Result<Vec<ReceiveRecord>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(self.dir.join("receives"))? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let r: ReceiveRecord = serde_json::from_slice(&std::fs::read(&path)?).with_context(|| format!("reading {}", path.display()))?;
            if r.state == State::Pending {
                out.push(r);
            }
        }
        Ok(out)
    }
}
