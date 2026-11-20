//! Configuration, all from the environment:
//!
//! | Variable | Default | |
//! | --- | --- | --- |
//! | `FEDIMINT_RECEIVER_TOKEN` | (required) | Bearer token every request must carry; at least 32 characters. |
//! | `FEDIMINT_RECEIVER_LISTEN` | `127.0.0.1:8790` | Address to listen on. |
//! | `FEDIMINT_RECEIVER_DATA_DIR` | `./data` | The client databases, the receive records and (when generated) the mnemonic. |
//! | `FEDIMINT_RECEIVER_MNEMONIC` | (unset) | The wallet's 12 BIP39 words. Unset: generated once into the data directory. |
//! | `RUST_LOG` | `info` | Log filter. |

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context as _, Result, bail};

pub const TOKEN_ENV: &str = "FEDIMINT_RECEIVER_TOKEN";
pub const LISTEN_ENV: &str = "FEDIMINT_RECEIVER_LISTEN";
pub const DATA_DIR_ENV: &str = "FEDIMINT_RECEIVER_DATA_DIR";
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8790";
pub const MIN_TOKEN_LEN: usize = 32;

pub struct Config {
    pub token: String,
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub mnemonic: Option<String>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("data_dir", &self.data_dir)
            .field("mnemonic", &self.mnemonic.as_ref().map(|_| "<from env>"))
            .finish_non_exhaustive()
    }
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let token = std::env::var(TOKEN_ENV).with_context(|| format!("{TOKEN_ENV} is not set"))?;
        if token.len() < MIN_TOKEN_LEN || !token.bytes().all(|b| b.is_ascii_graphic()) {
            bail!("{TOKEN_ENV} must be at least {MIN_TOKEN_LEN} printable characters with no spaces");
        }
        let listen = std::env::var(LISTEN_ENV).unwrap_or_else(|_| DEFAULT_LISTEN.to_owned());
        let listen = listen.parse().with_context(|| format!("{LISTEN_ENV} is not an address: {listen}"))?;
        Ok(Self { token, listen, data_dir: data_dir_from_env(), mnemonic: mnemonic_from_env() })
    }
}

/// `FEDIMINT_RECEIVER_DATA_DIR`, or `./data`.
pub fn data_dir_from_env() -> PathBuf {
    std::env::var_os(DATA_DIR_ENV).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("data"))
}

/// `FEDIMINT_RECEIVER_MNEMONIC`, when set and not blank.
pub fn mnemonic_from_env() -> Option<String> {
    std::env::var(crate::seed::MNEMONIC_ENV).ok().filter(|m| !m.trim().is_empty())
}
