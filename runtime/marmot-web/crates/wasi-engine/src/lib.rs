//! Minimal C ABI for the browser-hosted WASI engine module.
//!
//! The Worker serializes calls, so one retained response buffer is sufficient.
//! Protocol values never cross this ABI; only the product-level vector report
//! is exposed as UTF-8 JSON.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const STORAGE_KEY_BYTES: usize = 32;
const STORAGE_SLOT_COUNT: u32 = 2;
#[cfg(target_os = "wasi")]
const MAX_STORAGE_SLOT_BYTES: usize = 65 * 1024 * 1024;
#[cfg(target_os = "wasi")]
const MAX_COMMAND_INPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
struct DurableStorageReport {
    image_bytes: usize,
    encrypted_at_rest: bool,
    torn_write_recovered: bool,
    latest: storage_sqlite_web::DecryptedSqliteImage,
}

struct PendingRelayState {
    pair: runtime::BrowserEnginePair,
    staged: runtime::StagedRelayUpdate,
    latest: storage_sqlite_web::DecryptedSqliteImage,
    storage_key: [u8; STORAGE_KEY_BYTES],
}

struct OpenBrowserProfile {
    profile: runtime::BrowserProfile,
    role: Option<runtime::BrowserProfileRole>,
    latest: storage_sqlite_web::DecryptedSqliteImage,
    storage_key: [u8; STORAGE_KEY_BYTES],
    staged_group: Option<runtime::StagedProfileGroup>,
    staged_auto_publish: Option<runtime::StagedProfileAutoPublish>,
}

trait SlotStore {
    fn read(&self, slot: u32) -> Result<Option<Vec<u8>>, String>;
    fn write(&mut self, slot: u32, bytes: &[u8]) -> Result<(), String>;
}

#[cfg(target_os = "wasi")]
struct HostSlotStore;

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "marmot_storage")]
unsafe extern "C" {
    fn command_input_len() -> i32;
    fn command_input_read(destination: *mut u8, capacity: u32) -> i32;
    fn storage_key_read(destination: *mut u8, capacity: u32) -> i32;
    fn identity_secret_read(destination: *mut u8, capacity: u32) -> i32;
    fn slot_len(slot: u32) -> i32;
    fn slot_read(slot: u32, destination: *mut u8, capacity: u32) -> i32;
    fn slot_write(slot: u32, source: *const u8, length: u32) -> i32;
}

#[cfg(target_os = "wasi")]
impl SlotStore for HostSlotStore {
    fn read(&self, slot: u32) -> Result<Option<Vec<u8>>, String> {
        validate_slot(slot)?;
        let length = unsafe { slot_len(slot) };
        if length < 0 {
            return Err("OPFS slot length read failed".into());
        }
        let length = usize::try_from(length).map_err(|_| "OPFS slot length is invalid")?;
        if length == 0 {
            return Ok(None);
        }
        if length > MAX_STORAGE_SLOT_BYTES {
            return Err("OPFS slot exceeds the storage limit".into());
        }
        let mut bytes = vec![0_u8; length];
        let read = unsafe {
            slot_read(
                slot,
                bytes.as_mut_ptr(),
                u32::try_from(bytes.len()).map_err(|_| "OPFS slot is too large")?,
            )
        };
        if read < 0 || usize::try_from(read).ok() != Some(length) {
            return Err("OPFS slot read was incomplete".into());
        }
        Ok(Some(bytes))
    }

    fn write(&mut self, slot: u32, bytes: &[u8]) -> Result<(), String> {
        validate_slot(slot)?;
        if bytes.is_empty() || bytes.len() > MAX_STORAGE_SLOT_BYTES {
            return Err("OPFS slot write size is invalid".into());
        }
        let result = unsafe {
            slot_write(
                slot,
                bytes.as_ptr(),
                u32::try_from(bytes.len()).map_err(|_| "OPFS slot is too large")?,
            )
        };
        if result != 0 {
            return Err("OPFS slot write or flush failed".into());
        }
        Ok(())
    }
}

#[cfg(not(target_os = "wasi"))]
#[derive(Default)]
struct HostSlotStore {
    slots: [Option<Vec<u8>>; 2],
}

#[cfg(not(target_os = "wasi"))]
impl SlotStore for HostSlotStore {
    fn read(&self, slot: u32) -> Result<Option<Vec<u8>>, String> {
        validate_slot(slot)?;
        Ok(self.slots[slot as usize].clone())
    }

    fn write(&mut self, slot: u32, bytes: &[u8]) -> Result<(), String> {
        validate_slot(slot)?;
        self.slots[slot as usize] = Some(bytes.to_vec());
        Ok(())
    }
}

fn response_buffer() -> &'static Mutex<Vec<u8>> {
    static RESPONSE: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();
    RESPONSE.get_or_init(|| Mutex::new(Vec::new()))
}

fn pending_relay_state() -> &'static Mutex<Option<PendingRelayState>> {
    static STATE: OnceLock<Mutex<Option<PendingRelayState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn open_browser_profile() -> &'static Mutex<Option<OpenBrowserProfile>> {
    static STATE: OnceLock<Mutex<Option<OpenBrowserProfile>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn store_response(outcome: Result<Vec<u8>, String>) -> i32 {
    let (status, bytes) = match outcome {
        Ok(bytes) => (0, bytes),
        Err(error) => (
            1,
            serde_json::json!({ "error": error })
                .to_string()
                .into_bytes(),
        ),
    };
    *response_buffer()
        .lock()
        .expect("WASI response buffer lock poisoned") = bytes;
    status
}

#[unsafe(no_mangle)]
pub extern "C" fn run_engine_vector() -> i32 {
    let outcome = (|| {
        let storage_key = load_storage_key()?;
        let (sqlite_image, sqlite_recovered) = storage_sqlite_web::sqlite_image_round_trip()?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let durable_storage = run_durable_storage_vector(&mut slot_store, &storage_key)?;
        let mdk_previous_state_recovered =
            match storage_sqlite_web::maybe_runtime_accounts_checkpoint(
                &durable_storage.latest.image,
            )? {
                Some(checkpoint) => {
                    runtime::verify_completed_engine_checkpoint(
                        &checkpoint.alice,
                        &checkpoint.bob,
                    )?;
                    true
                }
                None => false,
            };
        let mut latest = durable_storage.latest;
        let mut storage_image_bytes = durable_storage.image_bytes;
        let mut persisted_checkpoints = 0_u64;
        let report =
            futures::executor::block_on(runtime::run_two_client_engine_vector_with_checkpoints(
                || async {
                    let started = Instant::now();
                    while started.elapsed() < Duration::from_millis(75) {
                        std::hint::spin_loop();
                    }
                    Ok(())
                },
                |_stage, alice, bob| {
                    let (committed, encrypted_bytes) = commit_runtime_accounts(
                        &mut slot_store,
                        &latest,
                        alice,
                        bob,
                        &storage_key,
                    )?;
                    latest = committed;
                    storage_image_bytes = encrypted_bytes;
                    persisted_checkpoints += 1;
                    let checkpoint =
                        storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?;
                    Ok((checkpoint.alice, checkpoint.bob))
                },
            ))?;
        if persisted_checkpoints != 5 {
            return Err(format!(
                "engine persisted {persisted_checkpoints} checkpoints instead of 5"
            ));
        }
        runtime::verify_completed_engine_checkpoint(
            &storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?.alice,
            &storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?.bob,
        )?;
        let mut report = serde_json::to_value(report)
            .map_err(|error| format!("engine report encoding failed: {error}"))?;
        let object = report
            .as_object_mut()
            .ok_or_else(|| "engine report was not a JSON object".to_owned())?;
        object.insert("sqliteVector".into(), serde_json::json!("passed"));
        object.insert(
            "sqliteImageBytes".into(),
            serde_json::json!(sqlite_image.len()),
        );
        object.insert(
            "sqliteRecovered".into(),
            serde_json::json!(sqlite_recovered),
        );
        object.insert(
            "mdkPreviousStateRecovered".into(),
            serde_json::json!(mdk_previous_state_recovered),
        );
        object.insert(
            "storageDurable".into(),
            serde_json::json!("opfs-encrypted-sqlite-image"),
        );
        object.insert(
            "storageEncryptedAtRest".into(),
            serde_json::json!(durable_storage.encrypted_at_rest),
        );
        object.insert(
            "storageGeneration".into(),
            serde_json::json!(latest.generation),
        );
        object.insert(
            "storageImageBytes".into(),
            serde_json::json!(storage_image_bytes),
        );
        object.insert(
            "storageTornWriteRecovered".into(),
            serde_json::json!(durable_storage.torn_write_recovered),
        );
        serde_json::to_vec(&report)
            .map_err(|error| format!("engine report encoding failed: {error}"))
    })();
    store_response(outcome)
}

/// Restores the latest stable engines, stages one real MDK state update, and
/// durably checkpoints the unresolved pending state before returning the
/// opaque signed event to the Worker for asynchronous relay publication.
#[unsafe(no_mangle)]
pub extern "C" fn prepare_relay_publish() -> i32 {
    let outcome = (|| {
        let mut retained = pending_relay_state()
            .lock()
            .map_err(|_| "pending relay state lock poisoned".to_owned())?;
        if retained.is_some() {
            return Err("a relay publication is already pending".into());
        }
        let storage_key = load_storage_key()?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let latest = load_latest(&slot_store, &storage_key)?.ok_or_else(|| {
            "the MDK runtime must be initialized before relay publication".to_owned()
        })?;
        let checkpoint = storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?;
        let mut pair = runtime::restore_browser_engine_pair(&checkpoint.alice, &checkpoint.bob)?;
        let updated_name = format!("Relay-confirmed generation {}", latest.generation + 1);
        let staged = futures::executor::block_on(runtime::stage_browser_relay_update(
            &mut pair,
            updated_name,
        ))?;
        let (alice, bob) = runtime::export_browser_engine_pair(&pair)?;
        let (latest, encrypted_bytes) =
            commit_runtime_accounts(&mut slot_store, &latest, &alice, &bob, &storage_key)?;
        let response = serde_json::json!({
            "eventId": staged.event_id,
            "eventJson": staged.event_json,
            "pendingGeneration": latest.generation,
            "storageImageBytes": encrypted_bytes,
        });
        *retained = Some(PendingRelayState {
            pair,
            staged,
            latest,
            storage_key,
        });
        serde_json::to_vec(&response)
            .map_err(|error| format!("relay prepare report encoding failed: {error}"))
    })();
    store_response(outcome)
}

/// Applies the relay acknowledgement to the retained MDK pending reference,
/// then checkpoints either the confirmed state or the exact rollback before
/// reporting completion to JavaScript.
#[unsafe(no_mangle)]
pub extern "C" fn resolve_relay_publish(accepted: u32) -> i32 {
    let outcome = (|| {
        if accepted > 1 {
            return Err("relay acknowledgement flag is invalid".into());
        }
        let mut state = pending_relay_state()
            .lock()
            .map_err(|_| "pending relay state lock poisoned".to_owned())?
            .take()
            .ok_or_else(|| "no relay publication is pending".to_owned())?;
        let resolution = futures::executor::block_on(runtime::resolve_browser_relay_update(
            &mut state.pair,
            state.staged,
            accepted == 1,
        ))?;
        let (alice, bob) = runtime::export_browser_engine_pair(&state.pair)?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let (latest, encrypted_bytes) = commit_runtime_accounts(
            &mut slot_store,
            &state.latest,
            &alice,
            &bob,
            &state.storage_key,
        )?;
        let mut response = serde_json::to_value(resolution)
            .map_err(|error| format!("relay resolution report encoding failed: {error}"))?;
        let object = response
            .as_object_mut()
            .ok_or_else(|| "relay resolution report was not an object".to_owned())?;
        object.insert(
            "storageGeneration".into(),
            serde_json::json!(latest.generation),
        );
        object.insert(
            "storageImageBytes".into(),
            serde_json::json!(encrypted_bytes),
        );
        serde_json::to_vec(&response)
            .map_err(|error| format!("relay resolution report encoding failed: {error}"))
    })();
    store_response(outcome)
}

/// Reopens a checkpoint left pending by an interrupted Worker. Exact MDK
/// hydration treats the unresolved publish as failed, emits its typed recovery
/// signal, and the cleared stable state is checkpointed before resync begins.
#[unsafe(no_mangle)]
pub extern "C" fn recover_interrupted_relay_publish() -> i32 {
    let outcome = (|| {
        if pending_relay_state()
            .lock()
            .map_err(|_| "pending relay state lock poisoned".to_owned())?
            .is_some()
        {
            return Err("an in-process relay publication must be resolved first".into());
        }
        let storage_key = load_storage_key()?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let latest = load_latest(&slot_store, &storage_key)?
            .ok_or_else(|| "the MDK runtime has no relay checkpoint to recover".to_owned())?;
        let checkpoint = storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?;
        let pair = runtime::restore_browser_engine_pair(&checkpoint.alice, &checkpoint.bob)?;
        if !pair.pending_publish_recovered {
            return Err("the MDK runtime found no interrupted relay publication".into());
        }
        let (alice, bob) = runtime::export_browser_engine_pair(&pair)?;
        let (latest, encrypted_bytes) =
            commit_runtime_accounts(&mut slot_store, &latest, &alice, &bob, &storage_key)?;
        serde_json::to_vec(&serde_json::json!({
            "pendingPublishRecovered": true,
            "storageGeneration": latest.generation,
            "storageImageBytes": encrypted_bytes,
        }))
        .map_err(|error| format!("relay recovery report encoding failed: {error}"))
    })();
    store_response(outcome)
}

/// Opens exactly one profile inside this Worker and persists only that
/// profile's state in this browser context's isolated OPFS namespace.
#[unsafe(no_mangle)]
pub extern "C" fn open_two_profile(role: u32) -> i32 {
    let outcome = (|| {
        let role = match role {
            0 => runtime::BrowserProfileRole::Alice,
            1 => runtime::BrowserProfileRole::Bob,
            _ => return Err("the browser profile role is invalid".into()),
        };
        let mut retained = open_browser_profile()
            .lock()
            .map_err(|_| "browser profile lock poisoned".to_owned())?;
        if retained.is_some() {
            return Err("a browser profile is already open".into());
        }
        let storage_key = load_storage_key()?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let (profile, latest) = match load_latest(&slot_store, &storage_key)? {
            Some(latest) => {
                let checkpoint = storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?;
                (
                    runtime::restore_browser_profile(role, &checkpoint.alice)?,
                    latest,
                )
            }
            None => {
                let durable = run_durable_storage_vector(&mut slot_store, &storage_key)?;
                let profile = runtime::new_browser_profile(role)?;
                let state = runtime::export_browser_profile(&profile)?;
                let (latest, _) = commit_runtime_accounts(
                    &mut slot_store,
                    &durable.latest,
                    &state,
                    &state,
                    &storage_key,
                )?;
                (profile, latest)
            }
        };
        let status = runtime::browser_profile_status(&profile)?;
        let generation = latest.generation;
        *retained = Some(OpenBrowserProfile {
            profile,
            role: Some(role),
            latest,
            storage_key,
            staged_group: None,
            staged_auto_publish: None,
        });
        profile_report(Some(role), generation, status, serde_json::Map::new())
    })();
    store_response(outcome)
}

/// Opens one product profile using an app-owned random identity secret. The
/// secret is stored only in the encrypted chat namespace and is never derived
/// from the wallet, passphrase, database key, or a fixed fixture role.
#[unsafe(no_mangle)]
pub extern "C" fn open_product_profile() -> i32 {
    let outcome = (|| {
        let mut retained = open_browser_profile()
            .lock()
            .map_err(|_| "browser profile lock poisoned".to_owned())?;
        if retained.is_some() {
            return Err("a browser profile is already open".into());
        }
        let storage_key = load_storage_key()?;
        let identity_secret = load_identity_secret()?;
        #[cfg(target_os = "wasi")]
        let mut slot_store = HostSlotStore;
        #[cfg(not(target_os = "wasi"))]
        let mut slot_store = HostSlotStore::default();
        let (profile, latest) = match load_latest(&slot_store, &storage_key)? {
            Some(latest) => {
                let checkpoint = storage_sqlite_web::runtime_accounts_checkpoint(&latest.image)?;
                (
                    runtime::restore_browser_profile_with_secret(
                        &identity_secret,
                        &checkpoint.alice,
                    )?,
                    latest,
                )
            }
            None => {
                let durable = run_durable_storage_vector(&mut slot_store, &storage_key)?;
                let profile = runtime::new_browser_profile_with_secret(&identity_secret)?;
                let state = runtime::export_browser_profile(&profile)?;
                let (latest, _) = commit_runtime_accounts(
                    &mut slot_store,
                    &durable.latest,
                    &state,
                    &state,
                    &storage_key,
                )?;
                (profile, latest)
            }
        };
        let status = runtime::browser_profile_status(&profile)?;
        let generation = latest.generation;
        *retained = Some(OpenBrowserProfile {
            profile,
            role: None,
            latest,
            storage_key,
            staged_group: None,
            staged_auto_publish: None,
        });
        profile_report(None, generation, status, serde_json::Map::new())
    })();
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_key_package_event() -> i32 {
    let outcome = with_open_profile(|state| {
        let (event_id, event_json) = futures::executor::block_on(
            runtime::browser_profile_key_package_event(&mut state.profile),
        )?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("eventId".into(), serde_json::json!(event_id));
        extra.insert("eventJson".into(), serde_json::json!(event_json));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_create_group() -> i32 {
    let outcome = with_open_profile(|state| {
        if state.staged_group.is_some() {
            return Err("a browser profile group publication is already pending".into());
        }
        let input = load_command_json()?;
        let key_package = required_string(&input, "keyPackageEventJson")?;
        let relay_endpoint = required_string(&input, "relayEndpoint")?;
        let staged = futures::executor::block_on(runtime::browser_profile_create_group(
            &mut state.profile,
            key_package,
            relay_endpoint,
        ))?;
        let event_id = staged.event_id.clone();
        let event_json = staged.event_json.clone();
        state.staged_group = Some(staged);
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("eventId".into(), serde_json::json!(event_id));
        extra.insert("eventJson".into(), serde_json::json!(event_json));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_resolve_group(accepted: u32) -> i32 {
    let outcome = with_open_profile(|state| {
        if accepted > 1 {
            return Err("the profile group acknowledgement flag is invalid".into());
        }
        let staged = state
            .staged_group
            .take()
            .ok_or_else(|| "no browser profile group publication is pending".to_owned())?;
        futures::executor::block_on(runtime::resolve_browser_profile_group(
            &mut state.profile,
            staged,
            accepted == 1,
        ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("accepted".into(), serde_json::json!(accepted == 1));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_leave() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let group_id = required_string(&input, "groupId")?;
        let (event_id, event_json) = futures::executor::block_on(runtime::browser_profile_leave(
            &mut state.profile,
            group_id,
        ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("eventId".into(), serde_json::json!(event_id));
        extra.insert("eventJson".into(), serde_json::json!(event_json));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_advance_convergence() -> i32 {
    let outcome = with_open_profile(|state| {
        if state.staged_auto_publish.is_some() {
            return Err("a browser profile auto-publication is already pending".into());
        }
        let input = load_command_json()?;
        let group_id = required_string(&input, "groupId")?;
        let staged = futures::executor::block_on(runtime::browser_profile_advance_convergence(
            &mut state.profile,
            group_id,
        ))?;
        let mut extra = serde_json::Map::new();
        match staged {
            Some(staged) => {
                extra.insert("autoPublish".into(), serde_json::json!(true));
                extra.insert("eventId".into(), serde_json::json!(staged.event_id));
                extra.insert("eventJson".into(), serde_json::json!(staged.event_json));
                state.staged_auto_publish = Some(staged);
                let (generation, image_bytes) = checkpoint_open_profile(state)?;
                extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
                let status = runtime::browser_profile_status(&state.profile)?;
                profile_report(state.role, generation, status, extra)
            }
            None => {
                extra.insert("autoPublish".into(), serde_json::json!(false));
                let status = runtime::browser_profile_status(&state.profile)?;
                profile_report(state.role, state.latest.generation, status, extra)
            }
        }
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_resolve_auto_publish(accepted: u32) -> i32 {
    let outcome = with_open_profile(|state| {
        if accepted > 1 {
            return Err("the profile auto-publication acknowledgement flag is invalid".into());
        }
        let staged = state
            .staged_auto_publish
            .take()
            .ok_or_else(|| "no browser profile auto-publication is pending".to_owned())?;
        futures::executor::block_on(runtime::resolve_browser_profile_auto_publish(
            &mut state.profile,
            staged,
            accepted == 1,
        ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("accepted".into(), serde_json::json!(accepted == 1));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_join_welcome() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let event_json = required_string(&input, "eventJson")?;
        futures::executor::block_on(runtime::browser_profile_join_welcome(
            &mut state.profile,
            event_json,
        ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_send_text() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let content = required_string(&input, "content")?;
        if content.is_empty() || content.len() > 16 * 1024 {
            return Err("the profile message size is invalid".into());
        }
        let (event_id, event_json) = futures::executor::block_on(
            runtime::browser_profile_send_text(&mut state.profile, content),
        )?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("eventId".into(), serde_json::json!(event_id));
        extra.insert("eventJson".into(), serde_json::json!(event_json));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_send_product_text() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let group_id = required_string(&input, "groupId")?;
        let content = required_string(&input, "content")?;
        if content.is_empty() || content.len() > 16 * 1024 {
            return Err("the profile message size is invalid".into());
        }
        let created_at = input
            .get("createdAt")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "the profile createdAt field is invalid".to_owned())?;
        let (event_id, event_json) =
            futures::executor::block_on(runtime::browser_profile_send_product_text(
                &mut state.profile,
                group_id,
                content,
                created_at,
            ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("eventId".into(), serde_json::json!(event_id));
        extra.insert("eventJson".into(), serde_json::json!(event_json));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_ingest_events() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let events = input
            .get("events")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "the profile event list is invalid".to_owned())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "a profile event is invalid".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if events.len() > 256 {
            return Err("the profile event list exceeds the limit".into());
        }
        let received = futures::executor::block_on(runtime::browser_profile_ingest_events(
            &mut state.profile,
            &events,
        ))?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("received".into(), serde_json::json!(received));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_ingest_product_events() -> i32 {
    let outcome = with_open_profile(|state| {
        let input = load_command_json()?;
        let group_id = required_string(&input, "groupId")?;
        let events = input
            .get("events")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "the profile event list is invalid".to_owned())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "a profile event is invalid".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if events.len() > 256 {
            return Err("the profile event list exceeds the limit".into());
        }
        let received = futures::executor::block_on(
            runtime::browser_profile_ingest_product_events(&mut state.profile, group_id, &events),
        )?;
        let (generation, image_bytes) = checkpoint_open_profile(state)?;
        let mut extra = serde_json::Map::new();
        extra.insert("received".into(), serde_json::json!(received));
        extra.insert("storageImageBytes".into(), serde_json::json!(image_bytes));
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(state.role, generation, status, extra)
    });
    store_response(outcome)
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_status() -> i32 {
    let outcome = with_open_profile(|state| {
        let status = runtime::browser_profile_status(&state.profile)?;
        profile_report(
            state.role,
            state.latest.generation,
            status,
            serde_json::Map::new(),
        )
    });
    store_response(outcome)
}

fn with_open_profile(
    operation: impl FnOnce(&mut OpenBrowserProfile) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let mut retained = open_browser_profile()
        .lock()
        .map_err(|_| "browser profile lock poisoned".to_owned())?;
    let state = retained
        .as_mut()
        .ok_or_else(|| "no browser profile is open".to_owned())?;
    operation(state)
}

fn checkpoint_open_profile(state: &mut OpenBrowserProfile) -> Result<(u64, usize), String> {
    let profile_state = runtime::export_browser_profile(&state.profile)?;
    #[cfg(target_os = "wasi")]
    let mut slot_store = HostSlotStore;
    #[cfg(not(target_os = "wasi"))]
    let mut slot_store = HostSlotStore::default();
    let (latest, image_bytes) = commit_runtime_accounts(
        &mut slot_store,
        &state.latest,
        &profile_state,
        &profile_state,
        &state.storage_key,
    )?;
    let generation = latest.generation;
    state.latest = latest;
    Ok((generation, image_bytes))
}

fn profile_report(
    role: Option<runtime::BrowserProfileRole>,
    generation: u64,
    status: runtime::BrowserProfileStatus,
    mut extra: serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<u8>, String> {
    let status = serde_json::to_value(status)
        .map_err(|error| format!("profile status encoding failed: {error}"))?;
    let status = status
        .as_object()
        .ok_or_else(|| "profile status was not an object".to_owned())?;
    extra.extend(status.clone());
    if let Some(role) = role {
        extra.insert(
            "role".into(),
            serde_json::json!(match role {
                runtime::BrowserProfileRole::Alice => "alice",
                runtime::BrowserProfileRole::Bob => "bob",
            }),
        );
    }
    extra.insert("storageGeneration".into(), serde_json::json!(generation));
    serde_json::to_vec(&serde_json::Value::Object(extra))
        .map_err(|error| format!("profile report encoding failed: {error}"))
}

fn required_string<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("the profile {field} field is invalid"))
}

#[cfg(target_os = "wasi")]
fn load_command_json() -> Result<serde_json::Value, String> {
    let length = unsafe { command_input_len() };
    if length <= 0 {
        return Err("the profile command input is empty".into());
    }
    let length = usize::try_from(length).map_err(|_| "the profile command input is invalid")?;
    if length > MAX_COMMAND_INPUT_BYTES {
        return Err("the profile command input exceeds the limit".into());
    }
    let mut input = vec![0_u8; length];
    let read = unsafe {
        command_input_read(
            input.as_mut_ptr(),
            u32::try_from(input.len()).map_err(|_| "the profile command input is too large")?,
        )
    };
    if usize::try_from(read).ok() != Some(length) {
        return Err("the profile command input read was incomplete".into());
    }
    serde_json::from_slice(&input).map_err(|_| "the profile command input is invalid JSON".into())
}

#[cfg(not(target_os = "wasi"))]
fn load_command_json() -> Result<serde_json::Value, String> {
    Err("profile command input is available only in the browser host".into())
}

fn load_storage_key() -> Result<[u8; STORAGE_KEY_BYTES], String> {
    #[cfg(target_os = "wasi")]
    {
        let mut key = [0_u8; STORAGE_KEY_BYTES];
        let read = unsafe {
            storage_key_read(
                key.as_mut_ptr(),
                u32::try_from(key.len()).expect("storage key length fits u32"),
            )
        };
        if read != i32::try_from(STORAGE_KEY_BYTES).expect("storage key length fits i32") {
            return Err("the app did not supply a 32-byte chat database key".into());
        }
        Ok(key)
    }
    #[cfg(not(target_os = "wasi"))]
    {
        Ok([0xa5; STORAGE_KEY_BYTES])
    }
}

fn load_identity_secret() -> Result<[u8; STORAGE_KEY_BYTES], String> {
    #[cfg(target_os = "wasi")]
    {
        let mut secret = [0_u8; STORAGE_KEY_BYTES];
        let read = unsafe {
            identity_secret_read(
                secret.as_mut_ptr(),
                u32::try_from(secret.len()).expect("identity secret length fits u32"),
            )
        };
        if read != i32::try_from(STORAGE_KEY_BYTES).expect("identity secret length fits i32") {
            return Err("the app did not supply a 32-byte chat identity secret".into());
        }
        Ok(secret)
    }
    #[cfg(not(target_os = "wasi"))]
    {
        Ok([0x5a; STORAGE_KEY_BYTES])
    }
}

fn run_durable_storage_vector(
    store: &mut impl SlotStore,
    storage_key: &[u8; STORAGE_KEY_BYTES],
) -> Result<DurableStorageReport, String> {
    let current = load_latest(store, storage_key)?;
    let base_generation = current
        .as_ref()
        .map(|checkpoint| checkpoint.generation)
        .unwrap_or(0);
    let base_image = current
        .as_ref()
        .map(|checkpoint| checkpoint.image.as_slice());

    let first_generation = base_generation
        .checked_add(1)
        .ok_or_else(|| "SQLite checkpoint generation overflowed".to_owned())?;
    let first_image = storage_sqlite_web::update_probe_image(base_image, first_generation)?;
    let first_encrypted =
        storage_sqlite_web::encrypt_sqlite_image(&first_image, storage_key, first_generation)?;
    store.write(slot_for_generation(first_generation), &first_encrypted)?;
    let first_reopened = load_latest(store, storage_key)?
        .ok_or_else(|| "first encrypted SQLite checkpoint was not durable".to_owned())?;
    if first_reopened.generation != first_generation
        || storage_sqlite_web::probe_image_generation(&first_reopened.image)? != first_generation
    {
        return Err("first encrypted SQLite checkpoint did not reopen".into());
    }

    let second_generation = first_generation
        .checked_add(1)
        .ok_or_else(|| "SQLite checkpoint generation overflowed".to_owned())?;
    let second_image =
        storage_sqlite_web::update_probe_image(Some(&first_reopened.image), second_generation)?;
    let second_encrypted =
        storage_sqlite_web::encrypt_sqlite_image(&second_image, storage_key, second_generation)?;
    let torn_length = second_encrypted.len() / 2;
    store.write(
        slot_for_generation(second_generation),
        &second_encrypted[..torn_length],
    )?;
    let torn_reopened = load_latest(store, storage_key)?
        .ok_or_else(|| "torn write destroyed every SQLite checkpoint".to_owned())?;
    let torn_write_recovered = torn_reopened.generation == first_generation;
    if !torn_write_recovered {
        return Err("torn write replaced the last committed SQLite checkpoint".into());
    }

    store.write(slot_for_generation(second_generation), &second_encrypted)?;
    let reopened = load_latest(store, storage_key)?
        .ok_or_else(|| "second encrypted SQLite checkpoint was not durable".to_owned())?;
    if reopened.generation != second_generation
        || storage_sqlite_web::probe_image_generation(&reopened.image)? != second_generation
    {
        return Err("second encrypted SQLite checkpoint did not reopen".into());
    }

    let encrypted_at_rest = !second_encrypted
        .windows(b"SQLite format 3\0".len())
        .any(|window| window == b"SQLite format 3\0")
        && !second_encrypted
            .windows(b"durable_runtime_probe".len())
            .any(|window| window == b"durable_runtime_probe");
    if !encrypted_at_rest {
        return Err("SQLite plaintext was visible in the OPFS checkpoint".into());
    }

    Ok(DurableStorageReport {
        image_bytes: second_encrypted.len(),
        encrypted_at_rest,
        torn_write_recovered,
        latest: reopened,
    })
}

fn commit_runtime_accounts(
    store: &mut impl SlotStore,
    previous: &storage_sqlite_web::DecryptedSqliteImage,
    alice: &[u8],
    bob: &[u8],
    storage_key: &[u8; STORAGE_KEY_BYTES],
) -> Result<(storage_sqlite_web::DecryptedSqliteImage, usize), String> {
    let generation = previous
        .generation
        .checked_add(1)
        .ok_or_else(|| "SQLite checkpoint generation overflowed".to_owned())?;
    let image = storage_sqlite_web::update_runtime_accounts_image(
        Some(&previous.image),
        generation,
        alice,
        bob,
    )?;
    let encrypted = storage_sqlite_web::encrypt_sqlite_image(&image, storage_key, generation)?;
    if encrypted
        .windows(b"SQLite format 3\0".len())
        .any(|window| window == b"SQLite format 3\0")
    {
        return Err("MDK state checkpoint exposed SQLite plaintext".into());
    }
    let encrypted_bytes = encrypted.len();
    store.write(slot_for_generation(generation), &encrypted)?;
    let reopened = load_latest(store, storage_key)?
        .ok_or_else(|| "MDK state checkpoint was not durable".to_owned())?;
    if reopened.generation != generation {
        return Err("MDK state checkpoint reopened the wrong generation".into());
    }
    let checkpoint = storage_sqlite_web::runtime_accounts_checkpoint(&reopened.image)?;
    if checkpoint.generation != generation || checkpoint.alice != alice || checkpoint.bob != bob {
        return Err("MDK state checkpoint did not atomically recover both accounts".into());
    }
    Ok((reopened, encrypted_bytes))
}

fn load_latest(
    store: &impl SlotStore,
    storage_key: &[u8; STORAGE_KEY_BYTES],
) -> Result<Option<storage_sqlite_web::DecryptedSqliteImage>, String> {
    let mut latest: Option<storage_sqlite_web::DecryptedSqliteImage> = None;
    let mut non_empty = false;
    for slot in 0..STORAGE_SLOT_COUNT {
        let Some(encrypted) = store.read(slot)? else {
            continue;
        };
        non_empty = true;
        let Ok(candidate) = storage_sqlite_web::decrypt_sqlite_image(&encrypted, storage_key)
        else {
            continue;
        };
        if latest
            .as_ref()
            .is_none_or(|checkpoint| candidate.generation > checkpoint.generation)
        {
            latest = Some(candidate);
        }
    }
    if non_empty && latest.is_none() {
        return Err("all encrypted SQLite checkpoints are corrupt or use the wrong key".into());
    }
    Ok(latest)
}

fn slot_for_generation(generation: u64) -> u32 {
    (generation % u64::from(STORAGE_SLOT_COUNT)) as u32
}

fn validate_slot(slot: u32) -> Result<(), String> {
    if slot >= STORAGE_SLOT_COUNT {
        return Err("invalid OPFS storage slot".into());
    }
    Ok(())
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_vector_result_ptr() -> *const u8 {
    response_buffer()
        .lock()
        .expect("WASI response buffer lock poisoned")
        .as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_vector_result_len() -> usize {
    response_buffer()
        .lock()
        .expect("WASI response buffer lock poisoned")
        .len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct PartialWriteFailureStore {
        inner: HostSlotStore,
        fail_next_write: bool,
    }

    impl SlotStore for PartialWriteFailureStore {
        fn read(&self, slot: u32) -> Result<Option<Vec<u8>>, String> {
            self.inner.read(slot)
        }

        fn write(&mut self, slot: u32, bytes: &[u8]) -> Result<(), String> {
            if self.fail_next_write {
                self.fail_next_write = false;
                self.inner.write(slot, &bytes[..bytes.len() / 2])?;
                return Err("simulated OPFS quota failure".into());
            }
            self.inner.write(slot, bytes)
        }
    }

    #[test]
    fn partial_quota_failure_preserves_the_previous_generation() {
        let mut store = PartialWriteFailureStore::default();
        let storage_key = load_storage_key().unwrap();
        let durable = run_durable_storage_vector(&mut store, &storage_key).unwrap();
        let generation = durable.latest.generation;
        store.fail_next_write = true;

        assert!(
            commit_runtime_accounts(&mut store, &durable.latest, b"alice", b"bob", &storage_key,)
                .is_err()
        );
        assert_eq!(
            load_latest(&store, &storage_key)
                .unwrap()
                .unwrap()
                .generation,
            generation
        );
    }
}
