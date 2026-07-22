//! App-owned SQLite storage primitives for the browser MDK runtime.
//!
//! The browser engine runs as a `wasm32-wasip1` reactor because the unmodified
//! MDK uses standard monotonic time. This crate first proves that the same
//! reactor can execute a bundled SQLite database and serialize its committed
//! image. Durable encrypted OPFS ownership is added at the Worker boundary.

use std::{ptr::NonNull, ptr::copy_nonoverlapping};

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rusqlite::{Connection, MAIN_DB, params, serialize::OwnedData};

const ENCRYPTED_IMAGE_MAGIC: &[u8; 8] = b"MMTDBIMG";
const ENCRYPTED_IMAGE_VERSION: u8 = 1;
const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;
const HEADER_BYTES: usize = ENCRYPTED_IMAGE_MAGIC.len() + 1 + 8 + NONCE_BYTES;
const MAX_SQLITE_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACCOUNT_STATE_BYTES: usize = 24 * 1024 * 1024;

/// A decrypted, authenticated SQLite database image and its commit generation.
#[derive(Debug, PartialEq, Eq)]
pub struct DecryptedSqliteImage {
    pub generation: u64,
    pub image: Vec<u8>,
}

/// Both MDK account/device storage aggregates recovered from one atomic
/// SQLite checkpoint used by the deterministic browser vector.
#[derive(Debug, PartialEq, Eq)]
pub struct RuntimeAccountsCheckpoint {
    pub generation: u64,
    pub alice: Vec<u8>,
    pub bob: Vec<u8>,
}

/// Runs a transaction, serializes the committed database, reopens it from the
/// image, and returns the recovered value.
///
/// This is intentionally small: it is both a native regression test and the
/// first Wasm/WASI storage gate before any MDK state is moved off memory.
pub fn sqlite_image_round_trip() -> Result<(Vec<u8>, String), String> {
    let mut source = Connection::open_in_memory().map_err(sqlite_error)?;
    source
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE runtime_probe (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               value TEXT NOT NULL
             );",
        )
        .map_err(sqlite_error)?;
    let transaction = source.transaction().map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO runtime_probe (id, value) VALUES (1, ?1)",
            params!["sqlite-wasi-committed"],
        )
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)?;

    let image = source.serialize(MAIN_DB).map_err(sqlite_error)?.to_vec();
    if image.len() < 16 || &image[..16] != b"SQLite format 3\0" {
        return Err("SQLite returned an invalid database image".into());
    }

    let reopened = connection_from_image(&image)?;
    let value = reopened
        .query_row("SELECT value FROM runtime_probe WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(sqlite_error)?;

    Ok((image, value))
}

/// Authenticates and encrypts a committed SQLite image with an independent
/// 256-bit chat database key.
pub fn encrypt_sqlite_image(
    image: &[u8],
    key: &[u8; 32],
    generation: u64,
) -> Result<Vec<u8>, String> {
    validate_sqlite_image(image)?;
    if generation == 0 {
        return Err("encrypted SQLite generation must be positive".into());
    }

    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::getrandom(&mut nonce)
        .map_err(|error| format!("secure SQLite nonce generation failed: {error}"))?;
    let mut header = Vec::with_capacity(HEADER_BYTES);
    header.extend_from_slice(ENCRYPTED_IMAGE_MAGIC);
    header.push(ENCRYPTED_IMAGE_VERSION);
    header.extend_from_slice(&generation.to_le_bytes());
    header.extend_from_slice(&nonce);

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "invalid chat database encryption key".to_owned())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: image,
                aad: &header,
            },
        )
        .map_err(|_| "SQLite image encryption failed".to_owned())?;
    header.extend_from_slice(&ciphertext);
    Ok(header)
}

/// Decrypts and authenticates a SQLite image. Wrong keys and corrupted bytes
/// intentionally share one public error classification.
pub fn decrypt_sqlite_image(
    encrypted: &[u8],
    key: &[u8; 32],
) -> Result<DecryptedSqliteImage, String> {
    if encrypted.len() < HEADER_BYTES + TAG_BYTES
        || encrypted.len() > HEADER_BYTES + TAG_BYTES + MAX_SQLITE_IMAGE_BYTES
        || &encrypted[..ENCRYPTED_IMAGE_MAGIC.len()] != ENCRYPTED_IMAGE_MAGIC
        || encrypted[ENCRYPTED_IMAGE_MAGIC.len()] != ENCRYPTED_IMAGE_VERSION
    {
        return Err("encrypted SQLite image is corrupt or unsupported".into());
    }
    let generation_offset = ENCRYPTED_IMAGE_MAGIC.len() + 1;
    let generation = u64::from_le_bytes(
        encrypted[generation_offset..generation_offset + 8]
            .try_into()
            .map_err(|_| "encrypted SQLite image is corrupt or unsupported".to_owned())?,
    );
    if generation == 0 {
        return Err("encrypted SQLite image is corrupt or unsupported".into());
    }
    let nonce_offset = generation_offset + 8;
    let nonce = &encrypted[nonce_offset..nonce_offset + NONCE_BYTES];
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "invalid chat database encryption key".to_owned())?;
    let image = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: &encrypted[HEADER_BYTES..],
                aad: &encrypted[..HEADER_BYTES],
            },
        )
        .map_err(|_| "encrypted SQLite image is corrupt or the key is incorrect".to_owned())?;
    validate_sqlite_image(&image)?;
    Ok(DecryptedSqliteImage { generation, image })
}

/// Creates or updates the durable SQLite checkpoint used by the browser WP2
/// crash/reload vector and returns a committed serialized image.
pub fn update_probe_image(previous: Option<&[u8]>, generation: u64) -> Result<Vec<u8>, String> {
    let mut connection = runtime_connection(previous)?;
    let generation_i64 = i64::try_from(generation)
        .map_err(|_| "SQLite checkpoint generation is too large".to_owned())?;
    let transaction = connection.transaction().map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO durable_runtime_probe (id, generation) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET generation = excluded.generation",
            params![generation_i64],
        )
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)?;
    let image = connection
        .serialize(MAIN_DB)
        .map_err(sqlite_error)?
        .to_vec();
    validate_sqlite_image(&image)?;
    Ok(image)
}

/// Atomically stores Alice and Bob's complete app-owned MDK/OpenMLS storage
/// aggregates with the durable checkpoint generation.
pub fn update_runtime_accounts_image(
    previous: Option<&[u8]>,
    generation: u64,
    alice: &[u8],
    bob: &[u8],
) -> Result<Vec<u8>, String> {
    if alice.is_empty()
        || bob.is_empty()
        || alice.len() > MAX_ACCOUNT_STATE_BYTES
        || bob.len() > MAX_ACCOUNT_STATE_BYTES
    {
        return Err("runtime account checkpoint size is invalid".into());
    }
    let generation_i64 = i64::try_from(generation)
        .map_err(|_| "SQLite checkpoint generation is too large".to_owned())?;
    let mut connection = runtime_connection(previous)?;
    let transaction = connection.transaction().map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO durable_runtime_probe (id, generation) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET generation = excluded.generation",
            params![generation_i64],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO runtime_accounts (name, state) VALUES ('alice', ?1)
             ON CONFLICT(name) DO UPDATE SET state = excluded.state",
            params![alice],
        )
        .map_err(sqlite_error)?;
    transaction
        .execute(
            "INSERT INTO runtime_accounts (name, state) VALUES ('bob', ?1)
             ON CONFLICT(name) DO UPDATE SET state = excluded.state",
            params![bob],
        )
        .map_err(sqlite_error)?;
    transaction.commit().map_err(sqlite_error)?;
    let image = connection
        .serialize(MAIN_DB)
        .map_err(sqlite_error)?
        .to_vec();
    validate_sqlite_image(&image)?;
    Ok(image)
}

/// Reopens one SQLite image and recovers both persisted account/device
/// aggregates from the same committed transaction.
pub fn runtime_accounts_checkpoint(image: &[u8]) -> Result<RuntimeAccountsCheckpoint, String> {
    maybe_runtime_accounts_checkpoint(image)?
        .ok_or_else(|| "SQLite checkpoint has no runtime account states".to_owned())
}

/// Returns no account checkpoint before the first MDK state boundary has been
/// committed; any partial account row set is treated as corruption.
pub fn maybe_runtime_accounts_checkpoint(
    image: &[u8],
) -> Result<Option<RuntimeAccountsCheckpoint>, String> {
    let connection = connection_from_image(image)?;
    let generation = probe_generation_from_connection(&connection)?;
    let count = connection
        .query_row("SELECT COUNT(*) FROM runtime_accounts", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(sqlite_error)?;
    if count == 0 {
        return Ok(None);
    }
    if count != 2 {
        return Err("SQLite checkpoint contains a partial runtime account set".into());
    }
    let state = |name: &str| {
        connection
            .query_row(
                "SELECT state FROM runtime_accounts WHERE name = ?1",
                params![name],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(sqlite_error)
    };
    Ok(Some(RuntimeAccountsCheckpoint {
        generation,
        alice: state("alice")?,
        bob: state("bob")?,
    }))
}

/// Reads the committed generation after reopening a serialized image.
pub fn probe_image_generation(image: &[u8]) -> Result<u64, String> {
    let connection = connection_from_image(image)?;
    probe_generation_from_connection(&connection)
}

fn probe_generation_from_connection(connection: &Connection) -> Result<u64, String> {
    let generation = connection
        .query_row(
            "SELECT generation FROM durable_runtime_probe WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sqlite_error)?;
    u64::try_from(generation).map_err(|_| "SQLite checkpoint generation is invalid".to_owned())
}

fn runtime_connection(previous: Option<&[u8]>) -> Result<Connection, String> {
    let connection = match previous {
        Some(image) => connection_from_image(image)?,
        None => Connection::open_in_memory().map_err(sqlite_error)?,
    };
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(sqlite_error)?;
    if schema_version != 0 && schema_version != 1 {
        return Err(format!(
            "SQLite runtime schema version {schema_version} is unsupported"
        ));
    }
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS durable_runtime_probe (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               generation INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS runtime_accounts (
               name TEXT PRIMARY KEY,
               state BLOB NOT NULL
             );
             PRAGMA user_version = 1;",
        )
        .map_err(sqlite_error)?;
    Ok(connection)
}

fn connection_from_image(image: &[u8]) -> Result<Connection, String> {
    validate_sqlite_image(image)?;
    let mut connection = Connection::open_in_memory().map_err(sqlite_error)?;
    connection
        .deserialize(MAIN_DB, owned_sqlite_data(image)?, false)
        .map_err(sqlite_error)?;
    Ok(connection)
}

fn validate_sqlite_image(image: &[u8]) -> Result<(), String> {
    if image.len() < 16
        || image.len() > MAX_SQLITE_IMAGE_BYTES
        || &image[..16] != b"SQLite format 3\0"
    {
        return Err("SQLite returned an invalid database image".into());
    }
    Ok(())
}

fn owned_sqlite_data(bytes: &[u8]) -> Result<OwnedData, String> {
    let size = i32::try_from(bytes.len())
        .map_err(|_| "SQLite database image exceeds the supported size".to_owned())?;
    let raw = unsafe { rusqlite::ffi::sqlite3_malloc(size) }.cast::<u8>();
    let pointer = NonNull::new(raw)
        .ok_or_else(|| "SQLite could not allocate the database image".to_owned())?;
    unsafe {
        copy_nonoverlapping(bytes.as_ptr(), pointer.as_ptr(), bytes.len());
        Ok(OwnedData::from_raw_nonnull(pointer, bytes.len()))
    }
}

fn sqlite_error(error: rusqlite::Error) -> String {
    format!("SQLite storage probe failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_image_reopens_with_the_same_value() {
        let (image, value) = sqlite_image_round_trip().unwrap();
        assert!(image.len() >= 8_192);
        assert_eq!(value, "sqlite-wasi-committed");
    }

    #[test]
    fn encrypted_image_rejects_wrong_keys_and_corruption() {
        let image = update_probe_image(None, 1).unwrap();
        let key = [7_u8; 32];
        let encrypted = encrypt_sqlite_image(&image, &key, 1).unwrap();

        assert_ne!(&encrypted[..16], b"SQLite format 3\0");
        assert!(!encrypted.windows(6).any(|window| window == b"SQLite"));
        assert_eq!(
            decrypt_sqlite_image(&encrypted, &key).unwrap(),
            DecryptedSqliteImage {
                generation: 1,
                image: image.clone(),
            }
        );
        assert!(decrypt_sqlite_image(&encrypted, &[8_u8; 32]).is_err());

        let mut corrupt = encrypted;
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(decrypt_sqlite_image(&corrupt, &key).is_err());
    }

    #[test]
    fn committed_checkpoint_survives_reopen() {
        let first = update_probe_image(None, 1).unwrap();
        assert_eq!(probe_image_generation(&first).unwrap(), 1);
        let second = update_probe_image(Some(&first), 2).unwrap();
        assert_eq!(probe_image_generation(&second).unwrap(), 2);
    }

    #[test]
    fn account_states_commit_and_reopen_atomically() {
        let image = update_runtime_accounts_image(None, 7, b"alice-state", b"bob-state").unwrap();
        assert_eq!(
            runtime_accounts_checkpoint(&image).unwrap(),
            RuntimeAccountsCheckpoint {
                generation: 7,
                alice: b"alice-state".to_vec(),
                bob: b"bob-state".to_vec(),
            }
        );
    }

    #[test]
    fn future_schema_versions_fail_closed() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE future_schema (id INTEGER PRIMARY KEY);
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        let image = connection.serialize(MAIN_DB).unwrap().to_vec();
        assert!(
            update_probe_image(Some(&image), 1)
                .unwrap_err()
                .contains("version 2 is unsupported")
        );
    }
}
