//! Browser-owned command runtime around the unmodified MDK engine.
//!
//! The public test vector deliberately passes only product-level results to
//! JavaScript. MLS plaintext, key material, KeyPackages, Welcome messages, and
//! transport envelopes remain inside Rust.

use std::{future::Future, sync::Arc};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use cgka_engine::{
    Engine, EngineBuilder,
    account_identity_proof::{AccountIdentityProofRequest, AccountIdentityProofSigner},
    canonicalization::ConvergenceStatus,
    feature_registry::FeatureRegistry,
};
use cgka_traits::{
    app_components::{
        AppComponentData, NOSTR_ROUTING_COMPONENT_ID, NostrRoutingV1, decode_nostr_routing_v1,
        default_group_components, encode_nostr_routing_v1,
    },
    app_event::{MARMOT_APP_EVENT_KIND_CHAT, MarmotAppEvent},
    capabilities::{Capability, CapabilityRequirement, Feature, RequirementLevel},
    engine::{
        CgkaEngine, CreateGroupRequest, GroupEvent, GroupStateChange, KeyPackage, SendIntent,
        SendResult,
    },
    engine_state::PendingStateRef,
    ingest::IngestOutcome,
    storage::{GroupStorage, MessageStorage},
    types::{EpochId, GroupId, MemberId, MessageId},
};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, TagKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use storage_memory::MemoryAccountStorage;
use transport_web::NostrWebPeeler;

const ALICE_MESSAGE: &str = "hello from browser alice";
const BOB_MESSAGE: &str = "hello from browser bob";
const SELF_REMOVE_FEATURE: Feature = Feature("self-remove");

#[derive(Clone)]
struct NostrAccountIdentityProofSigner {
    keys: Keys,
}

impl AccountIdentityProofSigner for NostrAccountIdentityProofSigner {
    fn sign_account_identity_proof(
        &self,
        request: &AccountIdentityProofRequest,
    ) -> Result<[u8; 64], String> {
        if self.keys.public_key().to_bytes().as_slice() != request.account_identity.as_slice() {
            return Err("account identity proof request does not match the runtime key".into());
        }
        let event = request.proof_event().and_then(|event| {
            event
                .sign_with_keys(&self.keys)
                .map_err(|error| error.to_string())
        })?;
        request.signature_from_signed_event(event)
    }
}

/// Browser-visible evidence for a complete two-client MDK lifecycle.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVectorReport {
    pub engine_vector: &'static str,
    pub flow: &'static str,
    pub alice_epoch: u64,
    pub bob_epoch: u64,
    pub alice_received: String,
    pub bob_received: String,
    pub bob_left: bool,
    pub mdk_state_reload: bool,
    pub publish_rollback: bool,
    pub storage_checkpoints: u64,
}

/// Two exact MDK engines restored from one durable browser checkpoint.
pub struct BrowserEnginePair {
    pub alice: Engine<MemoryAccountStorage>,
    pub alice_storage: MemoryAccountStorage,
    pub bob: Engine<MemoryAccountStorage>,
    pub bob_storage: MemoryAccountStorage,
    pub pending_publish_recovered: bool,
}

/// State retained only inside the WASI reactor between prepare and resolve.
pub struct StagedRelayUpdate {
    pending: PendingStateRef,
    group_id: GroupId,
    prior_epoch: EpochId,
    prior_name: String,
    updated_name: String,
    pub event_id: String,
    pub event_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayUpdateResolution {
    pub accepted: bool,
    pub epoch: u64,
    pub group_name: String,
    pub state_transition: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserProfileRole {
    Alice,
    Bob,
}

impl BrowserProfileRole {
    fn seed(self) -> &'static [u8] {
        match self {
            Self::Alice => b"alice-two-profile",
            Self::Bob => b"bob-two-profile",
        }
    }
}

pub struct BrowserProfile {
    engine: Engine<MemoryAccountStorage>,
    storage: MemoryAccountStorage,
    keys: Keys,
    pending_publish_recovered: bool,
}

pub struct StagedProfileGroup {
    pending: PendingStateRef,
    pub event_id: String,
    pub event_json: String,
}

pub struct StagedProfileAutoPublish {
    pending: PendingStateRef,
    pub event_id: String,
    pub event_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileStatus {
    pub epoch: u64,
    pub group_count: usize,
    pub group_id: Option<String>,
    pub member_count: usize,
    pub nostr_pubkey: String,
    pub pending_publish_recovered: bool,
    pub routing_group_id: Option<String>,
    pub groups: Vec<BrowserProfileGroupStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileGroupStatus {
    pub epoch: u64,
    pub group_id: String,
    pub member_count: usize,
    pub routing_group_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileReceivedChat {
    pub group_id: String,
    pub id: String,
    pub sender: String,
    pub created_at: u64,
    pub content: String,
}

/// Runs create/invite, bidirectional application messages, and a completed
/// MIP-03 leave through two independent real MDK engines.
///
/// The caller supplies the timer wait so this crate stays platform-neutral:
/// native tests can sleep on a thread while the Wasm entry point awaits the
/// Worker's `setTimeout` without blocking its event loop.
pub async fn run_two_client_engine_vector<Wait, WaitFuture>(
    wait_for_leave_jitter: Wait,
) -> Result<EngineVectorReport, String>
where
    Wait: FnOnce() -> WaitFuture,
    WaitFuture: Future<Output = Result<(), String>>,
{
    run_two_client_engine_vector_with_checkpoints(wait_for_leave_jitter, |_stage, alice, bob| {
        Ok((alice.to_vec(), bob.to_vec()))
    })
    .await
}

/// Runs the full vector while exporting, externally checkpointing, importing,
/// and hydrating both account/device storage aggregates at every durable
/// boundary.
pub async fn run_two_client_engine_vector_with_checkpoints<Wait, WaitFuture, Checkpoint>(
    wait_for_leave_jitter: Wait,
    mut checkpoint: Checkpoint,
) -> Result<EngineVectorReport, String>
where
    Wait: FnOnce() -> WaitFuture,
    WaitFuture: Future<Output = Result<(), String>>,
    Checkpoint: FnMut(&'static str, &[u8], &[u8]) -> Result<(Vec<u8>, Vec<u8>), String>,
{
    let mut alice_storage = MemoryAccountStorage::new();
    let mut bob_storage = MemoryAccountStorage::new();
    let mut alice = build_engine_with_storage(b"alice-browser-vector", alice_storage.clone())?;
    let mut bob = build_engine_with_storage(b"bob-browser-vector", bob_storage.clone())?;
    let bob_id = bob.self_id();

    let bob_key_package = bob
        .fresh_key_package()
        .await
        .map_err(|error| format!("Bob KeyPackage creation failed: {error}"))?;
    let bob_key_package = attach_key_package_source(bob_key_package);
    let routing = NostrRoutingV1::new(
        deterministic_bytes(b"browser-vector-group"),
        vec!["wss://relay.example".to_owned()],
    )?;

    let (group_id, create_result) = alice
        .create_group(CreateGroupRequest {
            name: "Browser vector".to_owned(),
            description: "Two unmodified MDK engines in one Worker".to_owned(),
            members: vec![bob_key_package],
            required_features: Vec::new(),
            app_components: vec![AppComponentData {
                component_id: NOSTR_ROUTING_COMPONENT_ID,
                data: encode_nostr_routing_v1(&routing)?,
            }],
            initial_admins: Vec::new(),
        })
        .await
        .map_err(|error| format!("group creation failed: {error}"))?;
    let (pending, welcomes) = match create_result {
        SendResult::GroupCreated { pending, welcomes } => (pending, welcomes),
        other => return Err(format!("group creation returned {other:?}")),
    };
    if welcomes.len() != 1 {
        return Err(format!(
            "group creation returned {} welcomes",
            welcomes.len()
        ));
    }
    alice
        .publish_failed(pending)
        .await
        .map_err(|error| format!("group creation rollback failed: {error}"))?;
    if alice
        .epoch(&group_id)
        .map_err(|error| format!("post-rollback epoch lookup failed: {error}"))?
        != EpochId(0)
        || alice
            .members(&group_id)
            .map_err(|error| format!("post-rollback member lookup failed: {error}"))?
            .len()
            != 1
    {
        return Err("failed group publication did not restore the solo creator".into());
    }
    (alice, alice_storage, bob, bob_storage) = checkpoint_pair(
        "publish-rollback",
        &alice_storage,
        &bob_storage,
        &mut checkpoint,
    )?;

    let retry_key_package = attach_key_package_source(
        bob.fresh_key_package()
            .await
            .map_err(|error| format!("Bob retry KeyPackage creation failed: {error}"))?,
    );
    let retry_invite = alice
        .send(SendIntent::Invite {
            group_id: group_id.clone(),
            key_packages: vec![retry_key_package],
        })
        .await
        .map_err(|error| format!("post-rollback invite failed: {error}"))?;
    let (retry_pending, mut retry_welcomes) = match retry_invite {
        SendResult::GroupEvolution {
            pending, welcomes, ..
        } => (pending, welcomes),
        other => return Err(format!("post-rollback invite returned {other:?}")),
    };
    if retry_welcomes.len() != 1 {
        return Err(format!(
            "post-rollback invite returned {} welcomes",
            retry_welcomes.len()
        ));
    }
    alice
        .confirm_published(retry_pending)
        .await
        .map_err(|error| format!("post-rollback invite confirmation failed: {error}"))?;
    let welcome = retry_welcomes.remove(0);
    bob.join_welcome(welcome)
        .await
        .map_err(|error| format!("Bob Welcome join failed: {error}"))?;
    alice.drain_events();
    bob.drain_events();
    (alice, alice_storage, bob, bob_storage) = checkpoint_pair(
        "invite-confirmed",
        &alice_storage,
        &bob_storage,
        &mut checkpoint,
    )?;

    let alice_message = send_chat(&mut alice, &group_id, ALICE_MESSAGE).await?;
    require_processed(
        bob.ingest(alice_message)
            .await
            .map_err(|error| format!("Bob ingest failed: {error}"))?,
        "Bob application ingest",
    )?;
    let bob_received = received_chat(&bob.drain_events())?;
    (alice, alice_storage, bob, bob_storage) = checkpoint_pair(
        "alice-message-received",
        &alice_storage,
        &bob_storage,
        &mut checkpoint,
    )?;

    let bob_message = send_chat(&mut bob, &group_id, BOB_MESSAGE).await?;
    require_processed(
        alice
            .ingest(bob_message)
            .await
            .map_err(|error| format!("Alice ingest failed: {error}"))?,
        "Alice application ingest",
    )?;
    let alice_received = received_chat(&alice.drain_events())?;
    (alice, alice_storage, bob, bob_storage) = checkpoint_pair(
        "bob-message-received",
        &alice_storage,
        &bob_storage,
        &mut checkpoint,
    )?;

    let leave_proposal = match bob
        .send(SendIntent::Leave {
            group_id: group_id.clone(),
        })
        .await
        .map_err(|error| format!("Bob leave intent failed: {error}"))?
    {
        SendResult::Proposal { msg } => msg,
        other => return Err(format!("Bob leave returned {other:?}")),
    };
    require_processed(
        alice
            .ingest(leave_proposal)
            .await
            .map_err(|error| format!("Alice leave-proposal ingest failed: {error}"))?,
        "Alice leave-proposal ingest",
    )?;

    wait_for_leave_jitter().await?;
    let released = alice
        .advance_convergence(&group_id)
        .await
        .map_err(|error| format!("Alice convergence tick failed: {error}"))?;
    if !released.is_empty() {
        return Err("leave convergence unexpectedly released queued sends".into());
    }
    let mut auto_publish = alice.drain_auto_publish();
    if auto_publish.len() != 1 {
        return Err(format!(
            "leave convergence produced {} auto-publish records",
            auto_publish.len()
        ));
    }
    let leave_commit = auto_publish.remove(0);
    alice
        .confirm_published(leave_commit.pending)
        .await
        .map_err(|error| format!("leave commit confirmation failed: {error}"))?;
    let alice_observed_leave = observed_departure(&alice.drain_events(), &bob_id);

    let bob_ingest = bob
        .ingest(leave_commit.msg)
        .await
        .map_err(|error| format!("Bob leave-commit ingest failed: {error}"))?;
    if !matches!(
        bob_ingest,
        IngestOutcome::Buffered { .. } | IngestOutcome::Processed
    ) {
        return Err(format!("Bob leave-commit ingest returned {bob_ingest:?}"));
    }
    if matches!(bob_ingest, IngestOutcome::Buffered { .. }) {
        let convergence = bob
            .converge_stored_openmls_messages(&group_id, 1_000_000)
            .map_err(|error| format!("Bob leave convergence failed: {error}"))?;
        if convergence.convergence_status != ConvergenceStatus::Settled {
            return Err(format!(
                "Bob leave convergence ended {:?}",
                convergence.convergence_status
            ));
        }
    }
    let bob_observed_leave = observed_departure(&bob.drain_events(), &bob_id);
    let alice_epoch = alice
        .epoch(&group_id)
        .map_err(|error| format!("Alice epoch lookup failed: {error}"))?;
    let bob_epoch = bob
        .epoch(&group_id)
        .map_err(|error| format!("Bob epoch lookup failed: {error}"))?;

    if bob_received != ALICE_MESSAGE || alice_received != BOB_MESSAGE {
        return Err("decrypted application message content did not round-trip".into());
    }
    if alice_epoch != EpochId(2) || bob_epoch != EpochId(2) {
        return Err(format!(
            "leave did not advance both engines to epoch 2: alice={alice_epoch}, bob={bob_epoch}"
        ));
    }
    if !alice_observed_leave || !bob_observed_leave {
        return Err(format!(
            "leave event missing: alice={alice_observed_leave}, bob={bob_observed_leave}"
        ));
    }
    (alice, alice_storage, bob, bob_storage) = checkpoint_pair(
        "leave-confirmed",
        &alice_storage,
        &bob_storage,
        &mut checkpoint,
    )?;
    let alice_epoch = alice
        .epoch(&group_id)
        .map_err(|error| format!("reopened Alice epoch lookup failed: {error}"))?;
    let bob_epoch = bob
        .epoch(&group_id)
        .map_err(|error| format!("reopened Bob epoch lookup failed: {error}"))?;
    if alice_epoch != EpochId(2) || bob_epoch != EpochId(2) {
        return Err("final checkpoint did not reopen both engines at epoch 2".into());
    }
    // Retain explicit ownership through the final check so both exported
    // aggregates are the exact stores used by the reopened engines.
    let _final_storages = (alice_storage, bob_storage);

    Ok(EngineVectorReport {
        engine_vector: "passed",
        flow: "create/invite/send/receive/leave",
        alice_epoch: alice_epoch.0,
        bob_epoch: bob_epoch.0,
        alice_received,
        bob_received,
        bob_left: true,
        mdk_state_reload: true,
        publish_rollback: true,
        storage_checkpoints: 5,
    })
}

fn build_engine_with_storage(
    seed: &[u8],
    storage: MemoryAccountStorage,
) -> Result<Engine<MemoryAccountStorage>, String> {
    let keys = deterministic_keys(seed)?;
    let identity = keys.public_key().to_bytes().to_vec();
    let mut components = default_group_components();
    components.insert(NOSTR_ROUTING_COMPONENT_ID);
    EngineBuilder::new(storage)
        .identity(identity)
        .account_identity_proof_signer(Arc::new(NostrAccountIdentityProofSigner {
            keys: keys.clone(),
        }))
        .feature_registry(feature_registry())
        .supported_app_components(components)
        .peeler(Box::new(NostrWebPeeler::new().with_welcome_keys(keys)))
        .build()
        .map_err(|error| format!("engine construction failed: {error}"))
}

fn checkpoint_pair<Checkpoint>(
    stage: &'static str,
    alice: &MemoryAccountStorage,
    bob: &MemoryAccountStorage,
    checkpoint: &mut Checkpoint,
) -> Result<
    (
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
    ),
    String,
>
where
    Checkpoint: FnMut(&'static str, &[u8], &[u8]) -> Result<(Vec<u8>, Vec<u8>), String>,
{
    let alice_state = alice
        .export_state()
        .map_err(|error| format!("Alice {stage} state export failed: {error}"))?;
    let bob_state = bob
        .export_state()
        .map_err(|error| format!("Bob {stage} state export failed: {error}"))?;
    let (alice_state, bob_state) = checkpoint(stage, &alice_state, &bob_state)?;
    restore_pair(&alice_state, &bob_state)
}

fn restore_pair(
    alice_state: &[u8],
    bob_state: &[u8],
) -> Result<
    (
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
    ),
    String,
> {
    let (alice, alice_storage, bob, bob_storage, _) =
        restore_pair_with_recovery(alice_state, bob_state)?;
    Ok((alice, alice_storage, bob, bob_storage))
}

fn restore_pair_with_recovery(
    alice_state: &[u8],
    bob_state: &[u8],
) -> Result<
    (
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
        Engine<MemoryAccountStorage>,
        MemoryAccountStorage,
        bool,
    ),
    String,
> {
    let alice_storage = MemoryAccountStorage::import_state(alice_state)
        .map_err(|error| format!("Alice state import failed: {error}"))?;
    let bob_storage = MemoryAccountStorage::import_state(bob_state)
        .map_err(|error| format!("Bob state import failed: {error}"))?;
    let mut alice = build_engine_with_storage(b"alice-browser-vector", alice_storage.clone())?;
    let mut bob = build_engine_with_storage(b"bob-browser-vector", bob_storage.clone())?;
    alice
        .hydrate_stable_groups_from_storage()
        .map_err(|error| format!("Alice checkpoint hydration failed: {error}"))?;
    bob.hydrate_stable_groups_from_storage()
        .map_err(|error| format!("Bob checkpoint hydration failed: {error}"))?;
    let pending_publish_recovered = alice
        .drain_events()
        .into_iter()
        .chain(bob.drain_events())
        .any(|event| matches!(event, GroupEvent::PendingCommitRecovered { .. }));
    Ok((
        alice,
        alice_storage,
        bob,
        bob_storage,
        pending_publish_recovered,
    ))
}

pub fn restore_browser_engine_pair(
    alice_state: &[u8],
    bob_state: &[u8],
) -> Result<BrowserEnginePair, String> {
    let (alice, alice_storage, bob, bob_storage, pending_publish_recovered) =
        restore_pair_with_recovery(alice_state, bob_state)?;
    Ok(BrowserEnginePair {
        alice,
        alice_storage,
        bob,
        bob_storage,
        pending_publish_recovered,
    })
}

pub fn export_browser_engine_pair(pair: &BrowserEnginePair) -> Result<(Vec<u8>, Vec<u8>), String> {
    let alice = pair
        .alice_storage
        .export_state()
        .map_err(|error| format!("Alice state export failed: {error}"))?;
    let bob = pair
        .bob_storage
        .export_state()
        .map_err(|error| format!("Bob state export failed: {error}"))?;
    Ok((alice, bob))
}

/// Stages one real state-advancing MDK update. The caller must durably persist
/// the returned pair before handing the opaque event to relay I/O.
pub async fn stage_browser_relay_update(
    pair: &mut BrowserEnginePair,
    updated_name: String,
) -> Result<StagedRelayUpdate, String> {
    let groups = pair
        .alice_storage
        .list_groups()
        .map_err(|error| format!("Alice group listing failed: {error}"))?;
    let group_id = groups
        .into_iter()
        .next()
        .ok_or_else(|| "Alice has no group for the relay update".to_owned())?;
    let prior_epoch = pair
        .alice
        .epoch(&group_id)
        .map_err(|error| format!("relay update epoch lookup failed: {error}"))?;
    let prior_name = pair
        .alice_storage
        .get_group(&group_id)
        .map_err(|error| format!("relay update group lookup failed: {error}"))?
        .name;
    let result = pair
        .alice
        .send(SendIntent::UpdateGroupData {
            group_id: group_id.clone(),
            name: Some(updated_name.clone()),
            description: None,
        })
        .await
        .map_err(|error| format!("relay update staging failed: {error}"))?;
    let (msg, pending) = match result {
        SendResult::GroupEvolution {
            msg,
            pending,
            welcomes,
        } if welcomes.is_empty() => (msg, pending),
        other => return Err(format!("relay update staging returned {other:?}")),
    };
    let event = transport_web::event_from_transport_message(&msg)
        .map_err(|error| format!("relay update event conversion failed: {error}"))?;
    Ok(StagedRelayUpdate {
        pending,
        group_id,
        prior_epoch,
        prior_name,
        updated_name,
        event_id: event.id.to_hex(),
        event_json: event.as_json(),
    })
}

pub async fn resolve_browser_relay_update(
    pair: &mut BrowserEnginePair,
    staged: StagedRelayUpdate,
    accepted: bool,
) -> Result<RelayUpdateResolution, String> {
    if accepted {
        pair.alice
            .confirm_published(staged.pending)
            .await
            .map_err(|error| format!("relay update confirmation failed: {error}"))?;
    } else {
        pair.alice
            .publish_failed(staged.pending)
            .await
            .map_err(|error| format!("relay update rollback failed: {error}"))?;
    }
    let epoch = pair
        .alice
        .epoch(&staged.group_id)
        .map_err(|error| format!("resolved relay update epoch lookup failed: {error}"))?;
    let group_name = pair
        .alice_storage
        .get_group(&staged.group_id)
        .map_err(|error| format!("resolved relay update group lookup failed: {error}"))?
        .name;
    let expected_epoch = if accepted {
        EpochId(staged.prior_epoch.0.saturating_add(1))
    } else {
        staged.prior_epoch
    };
    let expected_name = if accepted {
        &staged.updated_name
    } else {
        &staged.prior_name
    };
    if epoch != expected_epoch || &group_name != expected_name {
        return Err("relay acknowledgement resolved to inconsistent MDK state".into());
    }
    Ok(RelayUpdateResolution {
        accepted,
        epoch: epoch.0,
        group_name,
        state_transition: if accepted { "confirmed" } else { "rolled_back" },
    })
}

pub fn new_browser_profile(role: BrowserProfileRole) -> Result<BrowserProfile, String> {
    let secret = deterministic_bytes(role.seed());
    new_browser_profile_with_secret(&secret)
}

pub fn restore_browser_profile(
    role: BrowserProfileRole,
    state: &[u8],
) -> Result<BrowserProfile, String> {
    let secret = deterministic_bytes(role.seed());
    restore_browser_profile_with_secret(&secret, state)
}

pub fn new_browser_profile_with_secret(secret: &[u8]) -> Result<BrowserProfile, String> {
    if secret.len() != 32 {
        return Err("browser profile identity secret must be 32 bytes".into());
    }
    let storage = MemoryAccountStorage::new();
    browser_profile_from_storage(secret, storage)
}

pub fn restore_browser_profile_with_secret(
    secret: &[u8],
    state: &[u8],
) -> Result<BrowserProfile, String> {
    if secret.len() != 32 {
        return Err("browser profile identity secret must be 32 bytes".into());
    }
    let storage = MemoryAccountStorage::import_state(state)
        .map_err(|error| format!("profile state import failed: {error}"))?;
    browser_profile_from_storage(secret, storage)
}

fn browser_profile_from_storage(
    secret: &[u8],
    storage: MemoryAccountStorage,
) -> Result<BrowserProfile, String> {
    let keys = deterministic_keys(secret)?;
    let mut engine = build_engine_with_storage(secret, storage.clone())?;
    engine
        .hydrate_stable_groups_from_storage()
        .map_err(|error| format!("profile hydration failed: {error}"))?;
    let pending_publish_recovered = engine
        .drain_events()
        .into_iter()
        .any(|event| matches!(event, GroupEvent::PendingCommitRecovered { .. }));
    Ok(BrowserProfile {
        engine,
        storage,
        keys,
        pending_publish_recovered,
    })
}

pub fn export_browser_profile(profile: &BrowserProfile) -> Result<Vec<u8>, String> {
    profile
        .storage
        .export_state()
        .map_err(|error| format!("profile state export failed: {error}"))
}

pub async fn browser_profile_key_package_event(
    profile: &mut BrowserProfile,
) -> Result<(String, String), String> {
    let key_package = profile
        .engine
        .fresh_key_package()
        .await
        .map_err(|error| format!("profile KeyPackage creation failed: {error}"))?;
    let metadata = cgka_engine::key_package_metadata(&key_package)
        .map_err(|error| format!("profile KeyPackage metadata failed: {error}"))?;
    if metadata.credential_identity_hex != profile.keys.public_key().to_hex() {
        return Err("profile KeyPackage identity does not match its Nostr key".into());
    }
    let tags = [
        Tag::custom(TagKind::custom("d"), [metadata.key_package_ref_hex.clone()]),
        Tag::custom(TagKind::custom("mls_protocol_version"), ["1.0"]),
        Tag::custom(TagKind::custom("i"), [metadata.key_package_ref_hex]),
        Tag::custom(TagKind::custom("mls_ciphersuite"), ["0x0001"]),
        Tag::custom(
            TagKind::custom("mls_extensions"),
            ["0x0006", "0xf2f1", "0x000a"],
        ),
        Tag::custom(TagKind::custom("mls_proposals"), ["0x0008", "0x000a"]),
        Tag::custom(
            TagKind::custom("app_components"),
            ["0x8001", "0x8003", "0x8004"],
        ),
    ];
    let event = EventBuilder::new(
        Kind::Custom(30_443),
        BASE64_STANDARD.encode(key_package.bytes()),
    )
    .tags(tags)
    .sign_with_keys(&profile.keys)
    .map_err(|error| format!("profile KeyPackage signing failed: {error}"))?;
    Ok((event.id.to_hex(), event.as_json()))
}

fn key_package_from_event(event_json: &str) -> Result<(KeyPackage, [u8; 32]), String> {
    let event = Event::from_json(event_json)
        .map_err(|_| "profile KeyPackage event JSON is invalid".to_owned())?;
    event
        .verify()
        .map_err(|_| "profile KeyPackage event signature is invalid".to_owned())?;
    if event.kind != Kind::Custom(30_443) {
        return Err("profile event is not a Marmot KeyPackage".into());
    }
    let bytes = BASE64_STANDARD
        .decode(event.content.as_bytes())
        .map_err(|_| "profile KeyPackage content is not base64".to_owned())?;
    let key_package =
        KeyPackage::with_source_event_id(bytes, MessageId::new(event.id.to_bytes().to_vec()));
    let metadata = cgka_engine::key_package_metadata(&key_package)
        .map_err(|error| format!("profile KeyPackage validation failed: {error}"))?;
    if metadata.credential_identity_hex != event.pubkey.to_hex() {
        return Err("profile KeyPackage signer does not match its MLS identity".into());
    }
    Ok((key_package, event.id.to_bytes()))
}

pub async fn browser_profile_create_group(
    profile: &mut BrowserProfile,
    key_package_event_json: &str,
    relay_endpoint: &str,
) -> Result<StagedProfileGroup, String> {
    let (key_package, nostr_group_id) = key_package_from_event(key_package_event_json)?;
    let routing = NostrRoutingV1::new(nostr_group_id, vec![relay_endpoint.to_owned()])?;
    let (_, result) = profile
        .engine
        .create_group(CreateGroupRequest {
            name: "Two profile relay group".into(),
            description: "Chromium profile isolation vector".into(),
            members: vec![key_package],
            required_features: Vec::new(),
            app_components: vec![AppComponentData {
                component_id: NOSTR_ROUTING_COMPONENT_ID,
                data: encode_nostr_routing_v1(&routing)?,
            }],
            initial_admins: Vec::new(),
        })
        .await
        .map_err(|error| format!("profile group creation failed: {error}"))?;
    let (pending, welcome) = match result {
        SendResult::GroupCreated {
            pending,
            mut welcomes,
        } if welcomes.len() == 1 => (pending, welcomes.remove(0)),
        other => return Err(format!("profile group creation returned {other:?}")),
    };
    let event = transport_web::event_from_transport_message(&welcome)
        .map_err(|error| format!("profile Welcome event conversion failed: {error}"))?;
    Ok(StagedProfileGroup {
        pending,
        event_id: event.id.to_hex(),
        event_json: event.as_json(),
    })
}

pub async fn resolve_browser_profile_group(
    profile: &mut BrowserProfile,
    staged: StagedProfileGroup,
    accepted: bool,
) -> Result<(), String> {
    if accepted {
        profile
            .engine
            .confirm_published(staged.pending)
            .await
            .map_err(|error| format!("profile group confirmation failed: {error}"))?;
    } else {
        profile
            .engine
            .publish_failed(staged.pending)
            .await
            .map_err(|error| format!("profile group rollback failed: {error}"))?;
    }
    profile.engine.drain_events();
    Ok(())
}

pub async fn browser_profile_leave(
    profile: &mut BrowserProfile,
    group_id_hex: &str,
) -> Result<(String, String), String> {
    let group_id = profile_group_from_hex(profile, group_id_hex)?;
    let message = match profile
        .engine
        .send(SendIntent::Leave { group_id })
        .await
        .map_err(|error| format!("profile leave failed: {error}"))?
    {
        SendResult::Proposal { msg } => msg,
        other => return Err(format!("profile leave returned {other:?}")),
    };
    let event = transport_web::event_from_transport_message(&message)
        .map_err(|error| format!("profile leave event conversion failed: {error}"))?;
    Ok((event.id.to_hex(), event.as_json()))
}

pub async fn browser_profile_advance_convergence(
    profile: &mut BrowserProfile,
    group_id_hex: &str,
) -> Result<Option<StagedProfileAutoPublish>, String> {
    let group_id = profile_group_from_hex(profile, group_id_hex)?;
    let released = profile
        .engine
        .advance_convergence(&group_id)
        .await
        .map_err(|error| format!("profile convergence tick failed: {error}"))?;
    if !released.is_empty() {
        return Err("profile convergence unexpectedly released queued sends".into());
    }
    let mut auto_publish = profile.engine.drain_auto_publish();
    if auto_publish.is_empty() {
        return Ok(None);
    }
    if auto_publish.len() != 1 {
        return Err(format!(
            "profile convergence produced {} auto-publish records",
            auto_publish.len()
        ));
    }
    let staged = auto_publish.remove(0);
    let event = transport_web::event_from_transport_message(&staged.msg)
        .map_err(|error| format!("profile convergence event conversion failed: {error}"))?;
    Ok(Some(StagedProfileAutoPublish {
        pending: staged.pending,
        event_id: event.id.to_hex(),
        event_json: event.as_json(),
    }))
}

pub async fn resolve_browser_profile_auto_publish(
    profile: &mut BrowserProfile,
    staged: StagedProfileAutoPublish,
    accepted: bool,
) -> Result<(), String> {
    if accepted {
        profile
            .engine
            .confirm_published(staged.pending)
            .await
            .map_err(|error| format!("profile convergence confirmation failed: {error}"))?;
    } else {
        profile
            .engine
            .publish_failed(staged.pending)
            .await
            .map_err(|error| format!("profile convergence rollback failed: {error}"))?;
    }
    Ok(())
}

pub async fn browser_profile_join_welcome(
    profile: &mut BrowserProfile,
    event_json: &str,
) -> Result<(), String> {
    let event = Event::from_json(event_json)
        .map_err(|_| "profile Welcome event JSON is invalid".to_owned())?;
    let message = transport_web::event_to_transport_message(&event)
        .map_err(|error| format!("profile Welcome event is invalid: {error}"))?;
    profile
        .engine
        .join_welcome(message)
        .await
        .map_err(|error| format!("profile Welcome join failed: {error}"))?;
    profile.engine.drain_events();
    Ok(())
}

pub async fn browser_profile_send_text(
    profile: &mut BrowserProfile,
    content: &str,
) -> Result<(String, String), String> {
    let group_id = only_profile_group(profile)?;
    let message = send_chat_at(&mut profile.engine, &group_id, content, 1_700_000_000).await?;
    let event = transport_web::event_from_transport_message(&message)
        .map_err(|error| format!("profile message event conversion failed: {error}"))?;
    Ok((event.id.to_hex(), event.as_json()))
}

pub async fn browser_profile_send_product_text(
    profile: &mut BrowserProfile,
    group_id_hex: &str,
    content: &str,
    created_at: u64,
) -> Result<(String, String), String> {
    let group_id = profile_group_from_hex(profile, group_id_hex)?;
    let message = send_chat_at(&mut profile.engine, &group_id, content, created_at).await?;
    let event = transport_web::event_from_transport_message(&message)
        .map_err(|error| format!("profile message event conversion failed: {error}"))?;
    Ok((event.id.to_hex(), event.as_json()))
}

pub async fn browser_profile_ingest_events(
    profile: &mut BrowserProfile,
    event_json: &[String],
) -> Result<Vec<String>, String> {
    let mut received = Vec::new();
    for event_json in event_json {
        let event = Event::from_json(event_json)
            .map_err(|_| "profile group event JSON is invalid".to_owned())?;
        let message = transport_web::event_to_transport_message(&event)
            .map_err(|error| format!("profile group event is invalid: {error}"))?;
        let outcome = profile
            .engine
            .ingest(message)
            .await
            .map_err(|error| format!("profile group event ingest failed: {error}"))?;
        if !matches!(
            outcome,
            IngestOutcome::Processed
                | IngestOutcome::Stale {
                    reason: cgka_traits::ingest::StaleReason::AlreadySeen
                        | cgka_traits::ingest::StaleReason::OwnEcho
                        | cgka_traits::ingest::StaleReason::UnknownGroup
                }
        ) {
            return Err(format!("profile group event ingest returned {outcome:?}"));
        }
        received.extend(received_chats(&profile.engine.drain_events())?);
    }
    Ok(received)
}

pub async fn browser_profile_ingest_product_events(
    profile: &mut BrowserProfile,
    group_id_hex: &str,
    event_json: &[String],
) -> Result<Vec<BrowserProfileReceivedChat>, String> {
    let selected_group_id = profile_group_from_hex(profile, group_id_hex)?;
    let mut received = Vec::new();
    for event_json in event_json {
        let event = Event::from_json(event_json)
            .map_err(|_| "profile group event JSON is invalid".to_owned())?;
        let message = transport_web::event_to_transport_message(&event)
            .map_err(|error| format!("profile group event is invalid: {error}"))?;
        let outcome = profile
            .engine
            .ingest(message)
            .await
            .map_err(|error| format!("profile group event ingest failed: {error}"))?;
        let buffered = matches!(outcome, IngestOutcome::Buffered { .. });
        if !matches!(
            outcome,
            IngestOutcome::Processed
                | IngestOutcome::Buffered { .. }
                | IngestOutcome::Stale {
                    reason: cgka_traits::ingest::StaleReason::AlreadySeen
                        | cgka_traits::ingest::StaleReason::OwnEcho
                        | cgka_traits::ingest::StaleReason::UnknownGroup
                }
        ) {
            return Err(format!("profile group event ingest returned {outcome:?}"));
        }
        if buffered {
            let convergence = profile
                .engine
                .converge_stored_openmls_messages(&selected_group_id, 1_000_000)
                .map_err(|error| format!("profile buffered convergence failed: {error}"))?;
            if convergence.convergence_status != ConvergenceStatus::Settled {
                return Err(format!(
                    "profile buffered convergence ended {:?}",
                    convergence.convergence_status
                ));
            }
        }
        received.extend(received_product_chats(&profile.engine.drain_events())?);
    }
    Ok(received)
}

pub fn browser_profile_status(profile: &BrowserProfile) -> Result<BrowserProfileStatus, String> {
    let groups = profile
        .storage
        .list_groups()
        .map_err(|error| format!("profile group listing failed: {error}"))?;
    let group_statuses = groups
        .iter()
        .map(|group_id| profile_group_status(profile, group_id))
        .collect::<Result<Vec<_>, _>>()?;
    let first = group_statuses.first();
    Ok(BrowserProfileStatus {
        epoch: first.map(|group| group.epoch).unwrap_or(0),
        group_count: groups.len(),
        group_id: first.map(|group| group.group_id.clone()),
        member_count: first.map(|group| group.member_count).unwrap_or(0),
        nostr_pubkey: profile.keys.public_key().to_hex(),
        pending_publish_recovered: profile.pending_publish_recovered,
        routing_group_id: first.map(|group| group.routing_group_id.clone()),
        groups: group_statuses,
    })
}

fn profile_group_status(
    profile: &BrowserProfile,
    group_id: &GroupId,
) -> Result<BrowserProfileGroupStatus, String> {
    let epoch = profile
        .engine
        .epoch(group_id)
        .map_err(|error| format!("profile epoch lookup failed: {error}"))?
        .0;
    let member_count = profile
        .engine
        .members(group_id)
        .map_err(|error| format!("profile membership lookup failed: {error}"))?
        .len();
    let routing_group_id = profile
        .engine
        .app_component(group_id, NOSTR_ROUTING_COMPONENT_ID)
        .map_err(|error| format!("profile routing component lookup failed: {error}"))?
        .ok_or_else(|| "profile Nostr routing component is missing".to_owned())
        .and_then(|bytes| decode_nostr_routing_v1(&bytes))
        .map(|routing| hex::encode(routing.nostr_group_id))?;
    Ok(BrowserProfileGroupStatus {
        epoch,
        group_id: hex::encode(group_id.as_slice()),
        member_count,
        routing_group_id,
    })
}

fn profile_group_from_hex(profile: &BrowserProfile, group_id_hex: &str) -> Result<GroupId, String> {
    let bytes = hex::decode(group_id_hex)
        .map_err(|_| "profile group identifier is not valid hex".to_owned())?;
    if bytes.len() != 16 {
        return Err("profile group identifier is not 16 bytes".into());
    }
    let selected = GroupId::new(bytes);
    let groups = profile
        .storage
        .list_groups()
        .map_err(|error| format!("profile group listing failed: {error}"))?;
    groups
        .into_iter()
        .find(|group_id| group_id == &selected)
        .ok_or_else(|| "profile group identifier is unknown".to_owned())
}

fn only_profile_group(profile: &BrowserProfile) -> Result<GroupId, String> {
    let groups = profile
        .storage
        .list_groups()
        .map_err(|error| format!("profile group listing failed: {error}"))?;
    if groups.len() != 1 {
        return Err(format!(
            "profile has {} groups instead of one",
            groups.len()
        ));
    }
    Ok(groups[0].clone())
}

fn received_chats(events: &[GroupEvent]) -> Result<Vec<String>, String> {
    events
        .iter()
        .filter_map(|event| match event {
            GroupEvent::MessageReceived { payload, .. } => Some(payload),
            _ => None,
        })
        .map(|payload| {
            MarmotAppEvent::decode(payload)
                .map(|event| event.content)
                .map_err(|error| format!("received chat decode failed: {error}"))
        })
        .collect()
}

fn received_product_chats(
    events: &[GroupEvent],
) -> Result<Vec<BrowserProfileReceivedChat>, String> {
    events
        .iter()
        .filter_map(|event| match event {
            GroupEvent::MessageReceived {
                group_id,
                sender,
                payload,
                ..
            } => Some((group_id, sender, payload)),
            _ => None,
        })
        .map(|(group_id, sender, payload)| {
            let event = MarmotAppEvent::decode(payload)
                .map_err(|error| format!("received chat decode failed: {error}"))?;
            let sender = hex::encode(sender.as_slice());
            event
                .validate_sender(&sender)
                .map_err(|error| format!("received chat sender failed: {error}"))?;
            Ok(BrowserProfileReceivedChat {
                group_id: hex::encode(group_id.as_slice()),
                id: event.id,
                sender,
                created_at: event.created_at,
                content: event.content,
            })
        })
        .collect()
}

/// Verifies that a checkpoint from a prior Worker reconstructs both completed
/// engines and their durable message records without exposing either state to
/// JavaScript.
pub fn verify_completed_engine_checkpoint(
    alice_state: &[u8],
    bob_state: &[u8],
) -> Result<(), String> {
    let (alice, alice_storage, bob, bob_storage) = restore_pair(alice_state, bob_state)?;
    let alice_groups = alice_storage
        .list_groups()
        .map_err(|error| format!("Alice stored groups failed: {error}"))?;
    let bob_groups = bob_storage
        .list_groups()
        .map_err(|error| format!("Bob stored groups failed: {error}"))?;
    if alice_groups.len() != 1 || bob_groups != alice_groups {
        return Err("reopened engine checkpoint did not contain one shared group".into());
    }
    let group_id = &alice_groups[0];
    if alice
        .epoch(group_id)
        .map_err(|error| format!("Alice reopened epoch failed: {error}"))?
        != EpochId(2)
        || bob
            .epoch(group_id)
            .map_err(|error| format!("Bob reopened epoch failed: {error}"))?
            != EpochId(2)
    {
        return Err("reopened engine checkpoint did not retain epoch 2".into());
    }
    let alice_messages = alice_storage
        .list_messages(group_id, EpochId(0))
        .map_err(|error| format!("Alice reopened messages failed: {error}"))?;
    let bob_messages = bob_storage
        .list_messages(group_id, EpochId(0))
        .map_err(|error| format!("Bob reopened messages failed: {error}"))?;
    if alice_messages.len() < 2 || bob_messages.len() < 2 {
        return Err("reopened engine checkpoint lost durable message records".into());
    }
    Ok(())
}

fn feature_registry() -> FeatureRegistry {
    let mut registry = FeatureRegistry::new();
    registry.register(
        SELF_REMOVE_FEATURE,
        CapabilityRequirement {
            requires: Capability::Proposal(10),
            level: RequirementLevel::Required,
            description: "MIP-03 SelfRemove",
        },
    );
    registry
}

fn deterministic_keys(seed: &[u8]) -> Result<Keys, String> {
    for counter in 0_u64..u64::MAX {
        let mut hasher = Sha256::new();
        hasher.update(b"marmot-web-runtime-key-v1");
        hasher.update(seed);
        hasher.update(counter.to_be_bytes());
        if let Ok(keys) = Keys::parse(&hex::encode(hasher.finalize())) {
            return Ok(keys);
        }
    }
    Err("deterministic Nostr key search exhausted".into())
}

fn deterministic_bytes(seed: &[u8]) -> [u8; 32] {
    Sha256::digest(seed).into()
}

fn attach_key_package_source(key_package: KeyPackage) -> KeyPackage {
    let event_id = MessageId::new(Sha256::digest(key_package.bytes()).to_vec());
    KeyPackage::with_source_event_id(key_package.bytes().to_vec(), event_id)
}

async fn send_chat(
    engine: &mut Engine<MemoryAccountStorage>,
    group_id: &GroupId,
    content: &str,
) -> Result<cgka_traits::transport::TransportMessage, String> {
    send_chat_at(engine, group_id, content, 1_700_000_000).await
}

async fn send_chat_at(
    engine: &mut Engine<MemoryAccountStorage>,
    group_id: &GroupId,
    content: &str,
    created_at: u64,
) -> Result<cgka_traits::transport::TransportMessage, String> {
    let payload = MarmotAppEvent::new(
        hex::encode(engine.self_id().as_slice()),
        created_at,
        MARMOT_APP_EVENT_KIND_CHAT,
        Vec::new(),
        content,
    )
    .encode()
    .map_err(|error| format!("application event encoding failed: {error}"))?;
    match engine
        .send(SendIntent::AppMessage {
            group_id: group_id.clone(),
            payload,
        })
        .await
        .map_err(|error| format!("application send failed: {error}"))?
    {
        SendResult::ApplicationMessage { msg } => Ok(msg),
        other => Err(format!("application send returned {other:?}")),
    }
}

fn require_processed(outcome: IngestOutcome, operation: &str) -> Result<(), String> {
    if matches!(outcome, IngestOutcome::Processed) {
        Ok(())
    } else {
        Err(format!("{operation} returned {outcome:?}"))
    }
}

fn received_chat(events: &[GroupEvent]) -> Result<String, String> {
    let payload = events.iter().find_map(|event| match event {
        GroupEvent::MessageReceived { payload, .. } => Some(payload),
        _ => None,
    });
    let payload = payload.ok_or_else(|| "MDK emitted no MessageReceived event".to_owned())?;
    MarmotAppEvent::decode(payload)
        .map(|event| event.content)
        .map_err(|error| format!("received Marmot app event was invalid: {error}"))
}

fn observed_departure(events: &[GroupEvent], member: &MemberId) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            GroupEvent::GroupStateChanged {
                change:
                    GroupStateChange::MemberRemoved { member: actual }
                    | GroupStateChange::MemberLeft { member: actual },
                ..
            } if actual == member
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_real_engines_complete_the_memory_vector() {
        let report = futures::executor::block_on(run_two_client_engine_vector(|| async {
            std::thread::sleep(std::time::Duration::from_millis(75));
            Ok(())
        }))
        .expect("two-client engine vector passes");

        assert_eq!(report.engine_vector, "passed");
        assert_eq!(report.alice_epoch, 2);
        assert_eq!(report.bob_epoch, 2);
        assert!(report.bob_left);
        assert!(report.mdk_state_reload);
        assert!(report.publish_rollback);
        assert_eq!(report.storage_checkpoints, 5);
    }

    #[test]
    fn relay_acknowledgements_confirm_or_rollback_real_mdk_state() {
        let mut latest = (Vec::new(), Vec::new());
        futures::executor::block_on(run_two_client_engine_vector_with_checkpoints(
            || async {
                std::thread::sleep(std::time::Duration::from_millis(75));
                Ok(())
            },
            |_stage, alice, bob| {
                latest = (alice.to_vec(), bob.to_vec());
                Ok((alice.to_vec(), bob.to_vec()))
            },
        ))
        .expect("baseline engine vector passes");

        let mut pair = restore_browser_engine_pair(&latest.0, &latest.1).expect("restore pair");
        let staged = futures::executor::block_on(stage_browser_relay_update(
            &mut pair,
            "Relay confirmed".into(),
        ))
        .expect("stage confirmed update");
        assert!(staged.event_json.contains(&staged.event_id));
        let confirmed =
            futures::executor::block_on(resolve_browser_relay_update(&mut pair, staged, true))
                .expect("confirm update");
        assert_eq!(confirmed.state_transition, "confirmed");
        assert_eq!(confirmed.epoch, 3);

        latest = export_browser_engine_pair(&pair).expect("export confirmed pair");
        let mut pair = restore_browser_engine_pair(&latest.0, &latest.1).expect("reopen pair");
        let staged = futures::executor::block_on(stage_browser_relay_update(
            &mut pair,
            "Must roll back".into(),
        ))
        .expect("stage rejected update");
        let rolled_back =
            futures::executor::block_on(resolve_browser_relay_update(&mut pair, staged, false))
                .expect("roll back update");
        assert_eq!(rolled_back.state_transition, "rolled_back");
        assert_eq!(rolled_back.epoch, 3);
        assert_eq!(rolled_back.group_name, "Relay confirmed");
    }

    #[test]
    fn two_profile_states_exchange_welcome_and_text_independently() {
        futures::executor::block_on(async {
            let mut alice = new_browser_profile(BrowserProfileRole::Alice).expect("Alice profile");
            let mut bob = new_browser_profile(BrowserProfileRole::Bob).expect("Bob profile");
            let (key_package_event_id, key_package_event) =
                browser_profile_key_package_event(&mut bob)
                    .await
                    .expect("Bob KeyPackage");
            let staged =
                browser_profile_create_group(&mut alice, &key_package_event, "wss://relay.example")
                    .await
                    .expect("Alice group");
            let welcome_event = staged.event_json.clone();
            resolve_browser_profile_group(&mut alice, staged, true)
                .await
                .expect("Alice confirm");
            browser_profile_join_welcome(&mut bob, &welcome_event)
                .await
                .expect("Bob join");

            let (_, alice_event) = browser_profile_send_text(&mut alice, "hello isolated Bob")
                .await
                .expect("Alice send");
            assert_eq!(
                browser_profile_ingest_events(&mut bob, &[alice_event.clone()])
                    .await
                    .expect("Bob ingest"),
                vec!["hello isolated Bob"]
            );
            assert!(
                browser_profile_ingest_events(&mut bob, &[alice_event])
                    .await
                    .expect("Bob dedupe")
                    .is_empty()
            );
            let (_, bob_event) = browser_profile_send_text(&mut bob, "hello isolated Alice")
                .await
                .expect("Bob send");
            assert_eq!(
                browser_profile_ingest_events(&mut alice, &[bob_event])
                    .await
                    .expect("Alice ingest"),
                vec!["hello isolated Alice"]
            );

            let alice_state = export_browser_profile(&alice).expect("Alice export");
            let bob_state = export_browser_profile(&bob).expect("Bob export");
            assert_ne!(alice_state, bob_state);
            let alice = restore_browser_profile(BrowserProfileRole::Alice, &alice_state)
                .expect("Alice reopen");
            let bob =
                restore_browser_profile(BrowserProfileRole::Bob, &bob_state).expect("Bob reopen");
            let alice_status = browser_profile_status(&alice).expect("Alice status");
            let bob_status = browser_profile_status(&bob).expect("Bob status");
            assert_eq!(alice_status.epoch, 1);
            assert_eq!(alice_status.epoch, bob_status.epoch);
            assert_eq!(alice_status.member_count, 2);
            assert_eq!(alice_status.member_count, bob_status.member_count);
            let expected_route = Some(key_package_event_id);
            assert_eq!(alice_status.routing_group_id, expected_route);
            assert_eq!(alice_status.routing_group_id, bob_status.routing_group_id);
        });
    }

    #[test]
    fn product_profile_addresses_two_groups_explicitly() {
        futures::executor::block_on(async {
            let mut alice = new_browser_profile_with_secret(&[0x11; 32]).expect("Alice profile");
            let mut bob = new_browser_profile_with_secret(&[0x22; 32]).expect("Bob profile");
            let mut carol = new_browser_profile_with_secret(&[0x33; 32]).expect("Carol profile");

            let (bob_route, bob_key_package) = browser_profile_key_package_event(&mut bob)
                .await
                .expect("Bob KeyPackage");
            let bob_group =
                browser_profile_create_group(&mut alice, &bob_key_package, "wss://relay.example")
                    .await
                    .expect("Alice/Bob group");
            let bob_welcome = bob_group.event_json.clone();
            resolve_browser_profile_group(&mut alice, bob_group, true)
                .await
                .expect("confirm Alice/Bob group");
            browser_profile_join_welcome(&mut bob, &bob_welcome)
                .await
                .expect("Bob join");

            let (carol_route, carol_key_package) = browser_profile_key_package_event(&mut carol)
                .await
                .expect("Carol KeyPackage");
            let carol_group =
                browser_profile_create_group(&mut alice, &carol_key_package, "wss://relay.example")
                    .await
                    .expect("Alice/Carol group");
            let carol_welcome = carol_group.event_json.clone();
            resolve_browser_profile_group(&mut alice, carol_group, true)
                .await
                .expect("confirm Alice/Carol group");
            browser_profile_join_welcome(&mut carol, &carol_welcome)
                .await
                .expect("Carol join");

            let alice_status = browser_profile_status(&alice).expect("Alice status");
            assert_eq!(alice_status.groups.len(), 2);
            let bob_group_id = alice_status
                .groups
                .iter()
                .find(|group| group.routing_group_id == bob_route)
                .expect("Bob route")
                .group_id
                .clone();
            let carol_group_id = alice_status
                .groups
                .iter()
                .find(|group| group.routing_group_id == carol_route)
                .expect("Carol route")
                .group_id
                .clone();

            let (_, bob_event) = browser_profile_send_product_text(
                &mut alice,
                &bob_group_id,
                "only Bob",
                1_700_000_001,
            )
            .await
            .expect("send to Bob group");
            let bob_received =
                browser_profile_ingest_product_events(&mut bob, &bob_group_id, &[bob_event])
                    .await
                    .expect("Bob ingest");
            assert_eq!(bob_received.len(), 1);
            assert_eq!(bob_received[0].content, "only Bob");

            let (_, carol_event) = browser_profile_send_product_text(
                &mut alice,
                &carol_group_id,
                "only Carol",
                1_700_000_002,
            )
            .await
            .expect("send to Carol group");
            let carol_received =
                browser_profile_ingest_product_events(&mut carol, &carol_group_id, &[carol_event])
                    .await
                    .expect("Carol ingest");
            assert_eq!(carol_received.len(), 1);
            assert_eq!(carol_received[0].content, "only Carol");
        });
    }
}
