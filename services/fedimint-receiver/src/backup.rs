//! Backups of a data directory, and putting one back (docs/FEDIMINT-RECEIVER.md, Backup and
//! recovery).
//!
//! A backup is one JSON document with the directory's small files: the seed's fingerprint, the
//! mnemonic when the seed was generated here, each federation's `federation.json` (its invite)
//! and every receive record. It does not hold the client databases. Their notes come back from
//! the seed (`recover`), and a client database older than the wallet's last receive must never be
//! used again: the mint v1 client derives each new note from a counter kept in it, so an old copy
//! would offer the federation note nonces it has seen already (it refuses them), and it would not
//! hold the notes received after it was made.
//!
//! Every small file is written whole (store.rs), so reading them while the service runs gets one
//! whole version of each: a backup of a live directory is consistent. The records do not depend
//! on one another. A record caught `pending` is settled again after a restore, under the restore
//! rule (wallet.rs).

use std::io::{IsTerminal as _, Read as _, Write as _};
use std::path::Path;

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};

use crate::seed::{CHECK_FILE, MNEMONIC_FILE};
use crate::store::{FederationFile, ReceiveRecord, State, Store, now};

pub const FORMAT: &str = "forge-fedimint-receiver-backup/1";

#[derive(Serialize, Deserialize)]
pub struct Bundle {
    pub format: String,
    pub created_at: u64,
    /// The receiver version that made it.
    pub version: String,
    /// The fingerprint of the seed (`seed-check`): a restore refuses a different seed.
    pub seed_check: String,
    /// The words, only when the seed was generated into the data directory: then the backup is
    /// the only copy of them outside the volume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mnemonic: Option<String>,
    pub federations: Vec<FederationFile>,
    pub receives: Vec<ReceiveRecord>,
}

impl std::fmt::Debug for Bundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bundle")
            .field("created_at", &self.created_at)
            .field("federations", &self.federations.len())
            .field("receives", &self.receives.len())
            .field("mnemonic", &self.mnemonic.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl Bundle {
    /// What a person may read about a backup: counts, never its content.
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({
            "format": self.format,
            "created_at": self.created_at,
            "federations": self.federations.len(),
            "receives": self.receives.len(),
            "pending": self.receives.iter().filter(|r| r.state == State::Pending).count(),
            "holds_mnemonic": self.mnemonic.is_some(),
        })
    }
}

/// Read a data directory into a backup. Safe while the service runs.
pub fn make(data_dir: &Path) -> Result<Bundle> {
    let seed_check = match std::fs::read_to_string(data_dir.join(CHECK_FILE)) {
        Ok(s) => s.trim().to_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            bail!("{} is not a receiver data directory (no {CHECK_FILE})", data_dir.display())
        }
        Err(e) => return Err(e).context("reading seed-check"),
    };
    let mnemonic = match std::fs::read_to_string(data_dir.join(MNEMONIC_FILE)) {
        Ok(words) => Some(words.trim().to_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).context("reading the mnemonic file"),
    };
    let store = Store { dir: data_dir.to_path_buf() };
    // A federation `recover` has not finished rebuilding is backed up from what it knew.
    let mut federations = store.federations()?;
    for id in store.federation_ids()? {
        if !federations.iter().any(|f| f.id == id)
            && let Some(f) = store.restore_file(&id)?
        {
            federations.push(f);
        }
    }
    Ok(Bundle {
        format: FORMAT.to_owned(),
        created_at: now(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        seed_check,
        mnemonic,
        federations,
        receives: store.receives()?,
    })
}

/// Write a backup to `out` (a new file, mode 0600, synced) or, with no `out`, to standard output,
/// which must not be a terminal: a backup can hold the words and pending notes.
pub fn write(bundle: &Bundle, out: Option<&Path>) -> Result<()> {
    let bytes = serde_json::to_vec(bundle)?;
    match out {
        Some(path) => crate::store::write_new_private(path, &bytes).with_context(|| format!("writing the backup to {}", path.display())),
        None => {
            let mut stdout = std::io::stdout().lock();
            if stdout.is_terminal() {
                bail!("a backup holds secrets and is not printed: redirect standard output to a file, or give --out FILE");
            }
            stdout.write_all(&bytes)?;
            stdout.flush()?;
            Ok(())
        }
    }
}

/// Read a backup from `path`, or from standard input for `-`.
pub fn read(path: &str) -> Result<Bundle> {
    let bytes = if path == "-" {
        let mut b = Vec::new();
        std::io::stdin().read_to_end(&mut b).context("reading the backup from standard input")?;
        b
    } else {
        std::fs::read(path).with_context(|| format!("reading the backup {path}"))?
    };
    let bundle: Bundle = serde_json::from_slice(&bytes).context("the backup is not a receiver backup")?;
    if bundle.format != FORMAT {
        bail!("the backup's format is {:?}; this receiver reads {FORMAT:?}", bundle.format);
    }
    Ok(bundle)
}

/// Whether `data_dir` holds nothing a backup would put there: no seed, no federation, no record.
pub fn is_empty(data_dir: &Path) -> Result<bool> {
    if data_dir.join(CHECK_FILE).exists() || data_dir.join(MNEMONIC_FILE).exists() {
        return Ok(false);
    }
    for sub in ["federations", "receives"] {
        match std::fs::read_dir(data_dir.join(sub)) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Ok(false);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", data_dir.join(sub).display())),
        }
    }
    Ok(true)
}

/// Put a backup's files into an empty data directory: the seed's fingerprint, the generated
/// mnemonic, the receive records, and a `restore.json` per federation for `recover` to rebuild.
/// The client databases are made by the recovery, never from the backup.
pub fn unpack(bundle: &Bundle, store: &Store) -> Result<()> {
    if !is_empty(&store.dir)? {
        bail!(
            "{} is not empty: a backup is restored only into an empty data directory. To resume a recovery that stopped, run `recover` again without --backup",
            store.dir.display()
        );
    }
    if let Some(words) = &bundle.mnemonic {
        crate::store::write_new_private(&store.dir.join(MNEMONIC_FILE), words.as_bytes()).context("writing the mnemonic file")?;
    }
    crate::store::write_atomic(&store.dir.join(CHECK_FILE), format!("{}\n", bundle.seed_check).as_bytes())?;
    for r in &bundle.receives {
        anyhow::ensure!(
            r.notes_id.len() == 64 && r.notes_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "the backup holds a record with a malformed notes_id"
        );
        store.save_receive(r)?;
    }
    for f in &bundle.federations {
        anyhow::ensure!(
            f.id.len() == 64 && f.id.bytes().all(|b| b.is_ascii_hexdigit()),
            "the backup holds a federation with a malformed id"
        );
        store.save_restore_file(f)?;
    }
    Ok(())
}
