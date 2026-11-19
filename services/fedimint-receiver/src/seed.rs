//! The wallet's root secret: one BIP39 mnemonic for every federation joined.
//!
//! In production it comes from `FEDIMINT_RECEIVER_MNEMONIC` and is never written to disk. Without
//! that variable it is generated once into `<data>/mnemonic` with mode 0600 and read from there on
//! every later start. Either way `<data>/seed-check` keeps a fingerprint (a hash, not the words),
//! so a data directory is never opened with a different seed than the one it was made with: the
//! client databases' notes belong to that seed.
//!
//! The mnemonic is derived the way fedimint's own clients and fedimint-sdk derive it
//! (`StandardDoubleDerive` over BIP39 with 12 words), so the same words recover in those too.

use std::path::Path;
use std::str::FromStr;

use anyhow::{Context, Result, bail};
use fedimint_bip39::{Bip39RootSecretStrategy, Mnemonic};
use fedimint_client::RootSecret;
use fedimint_client::secret::RootSecretStrategy as _;
use fedimint_core::bitcoin::hashes::{Hash as _, sha256};
use fedimint_core::secp256k1::rand::thread_rng;

pub const MNEMONIC_ENV: &str = "FEDIMINT_RECEIVER_MNEMONIC";
pub const MNEMONIC_FILE: &str = "mnemonic";
pub const CHECK_FILE: &str = "seed-check";

/// Where the seed came from, for the start-up log line (never the words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    FileExisting,
    FileCreated,
}

pub struct Seed {
    mnemonic: Mnemonic,
    pub source: Source,
}

impl std::fmt::Debug for Seed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Seed({:?}, <redacted>)", self.source)
    }
}

impl Seed {
    pub fn root_secret(&self) -> RootSecret {
        RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(&self.mnemonic))
    }

    fn fingerprint(&self) -> String {
        let mut data = b"forge-fedimint-receiver/seed-check/1\0".to_vec();
        data.extend_from_slice(&self.mnemonic.to_entropy());
        hex::encode(&sha256::Hash::hash(&data).to_byte_array()[..16])
    }
}

/// Load the seed for `data_dir`: from `env_words` when given, else from (or into) the mnemonic
/// file. Refuses a seed that does not match the directory's fingerprint, and an environment seed
/// that differs from a mnemonic file left in the directory.
pub fn load(data_dir: &Path, env_words: Option<&str>) -> Result<Seed> {
    let file = data_dir.join(MNEMONIC_FILE);
    let seed = match env_words {
        Some(words) => {
            let mnemonic = parse(words).with_context(|| format!("{MNEMONIC_ENV} is not a valid BIP39 mnemonic"))?;
            if let Ok(on_disk) = std::fs::read_to_string(&file)
                && parse(&on_disk).ok().map(|m| m.to_entropy()) != Some(mnemonic.to_entropy())
            {
                bail!("{MNEMONIC_ENV} differs from the mnemonic file in the data directory; remove one of them");
            }
            Seed { mnemonic, source: Source::Env }
        }
        None => match std::fs::read_to_string(&file) {
            Ok(words) => {
                Seed { mnemonic: parse(&words).context("the mnemonic file is not a valid BIP39 mnemonic")?, source: Source::FileExisting }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if data_dir.join(CHECK_FILE).exists() {
                    bail!("this data directory was made with a seed given in {MNEMONIC_ENV}; set it again");
                }
                let mnemonic = Bip39RootSecretStrategy::<12>::random(&mut thread_rng());
                crate::store::write_new_private(&file, mnemonic.to_string().as_bytes()).context("writing the mnemonic file")?;
                Seed { mnemonic, source: Source::FileCreated }
            }
            Err(e) => return Err(e).context("reading the mnemonic file"),
        },
    };
    let check = data_dir.join(CHECK_FILE);
    let fp = seed.fingerprint();
    match std::fs::read_to_string(&check) {
        Ok(existing) if existing.trim() == fp => {}
        Ok(_) => bail!("this seed is not the one the data directory was made with (seed-check differs); refusing to start"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            crate::store::write_atomic(&check, format!("{fp}\n").as_bytes()).context("writing seed-check")?;
        }
        Err(e) => return Err(e).context("reading seed-check"),
    }
    Ok(seed)
}

fn parse(words: &str) -> Result<Mnemonic> {
    let m = Mnemonic::from_str(words.trim()).map_err(|_| anyhow::anyhow!("not a BIP39 mnemonic"))?;
    if m.word_count() != 12 {
        bail!("the mnemonic must have 12 words");
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_seed_is_private_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = load(dir.path(), None).unwrap();
        assert_eq!(first.source, Source::FileCreated);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(MNEMONIC_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let again = load(dir.path(), None).unwrap();
        assert_eq!(again.source, Source::FileExisting);
        assert_eq!(again.fingerprint(), first.fingerprint());
    }

    #[test]
    fn an_env_seed_is_never_written_and_a_different_seed_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let words = Bip39RootSecretStrategy::<12>::random(&mut thread_rng()).to_string();
        let s = load(dir.path(), Some(&words)).unwrap();
        assert_eq!(s.source, Source::Env);
        assert!(!dir.path().join(MNEMONIC_FILE).exists());
        let check = std::fs::read_to_string(dir.path().join(CHECK_FILE)).unwrap();
        assert!(check.trim().len() == 32 && check.trim().chars().all(|c| c.is_ascii_hexdigit()), "{check}");

        let other = Bip39RootSecretStrategy::<12>::random(&mut thread_rng()).to_string();
        let err = load(dir.path(), Some(&other)).unwrap_err().to_string();
        assert!(err.contains("not the one the data directory was made with"), "{err}");
        // Nor may a generated seed take over a directory made with an env seed, and the refusal
        // leaves no mnemonic file behind.
        assert!(load(dir.path(), None).unwrap_err().to_string().contains("set it again"));
        assert!(!dir.path().join(MNEMONIC_FILE).exists());
        assert_eq!(load(dir.path(), Some(&words)).unwrap().source, Source::Env);
        assert!(load(dir.path(), Some("not a mnemonic")).is_err());
    }
}
