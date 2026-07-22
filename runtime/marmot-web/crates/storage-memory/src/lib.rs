//! App-owned, in-memory storage for the deterministic browser runtime.
//!
//! This backend deliberately provides no durability. It exists to run the
//! unmodified MDK engine in a browser Worker during WP1; OPFS-backed encrypted
//! persistence is a separate WP2 concern.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};

use cgka_traits::{
    capabilities::{CapabilityRequirement, Feature, GroupCapabilities},
    group::{Group, Member},
    message::{MessageRecord, MessageState},
    storage::{
        AccountDeviceSignerBinding, AccountDeviceSignerStorage, CapabilityStorage,
        ConvergencePolicyStorage, GroupStorage, LeaveRequest, LeaveRequestStorage,
        MemberValidationCacheStorage, MessageStorage, OutboundIntentStorage, QueuedOutboundIntent,
        StorageError, StorageProvider, StorageResult, WelcomeStorage,
    },
    types::{Backend, EpochId, GroupId, MemberId, MessageId},
    welcome::PendingWelcome,
};
use openmls_memory_storage::MemoryStorage;
use serde::{Deserialize, Serialize};

const PERSISTED_STORAGE_SCHEMA_VERSION: u32 = 1;
const MAX_PERSISTED_STORAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Default)]
struct AppState {
    groups: HashMap<GroupId, Group>,
    messages: Vec<MessageRecord>,
    queued_outbound: Vec<QueuedOutboundIntent>,
    leave_requests: HashMap<GroupId, LeaveRequest>,
    welcomes: Vec<PendingWelcome>,
    features: HashMap<Feature, CapabilityRequirement>,
    member_capabilities: HashMap<(GroupId, MemberId), GroupCapabilities>,
    convergence_policies: HashMap<GroupId, Vec<u8>>,
    validated_tree_markers: HashMap<GroupId, Vec<u8>>,
    account_device_signers: HashMap<MemberId, AccountDeviceSignerBinding>,
}

#[derive(Clone)]
struct Snapshot {
    app: AppState,
    mls: HashMap<Vec<u8>, Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedStorage {
    schema_version: u32,
    app: PersistedAppState,
    mls: Vec<(Vec<u8>, Vec<u8>)>,
    snapshots: Vec<PersistedSnapshot>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAppState {
    groups: Vec<Group>,
    messages: Vec<MessageRecord>,
    queued_outbound: Vec<QueuedOutboundIntent>,
    leave_requests: Vec<LeaveRequest>,
    welcomes: Vec<PendingWelcome>,
    member_capabilities: Vec<(GroupId, MemberId, GroupCapabilities)>,
    convergence_policies: Vec<(GroupId, Vec<u8>)>,
    validated_tree_markers: Vec<(GroupId, Vec<u8>)>,
    account_device_signers: Vec<AccountDeviceSignerBinding>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSnapshot {
    group_id: GroupId,
    name: String,
    app: PersistedAppState,
    mls: Vec<(Vec<u8>, Vec<u8>)>,
}

#[derive(Default)]
struct MemoryAccountStorageInner {
    app: Mutex<AppState>,
    snapshots: Mutex<HashMap<(GroupId, String), Snapshot>>,
    mls: MemoryStorage,
}

/// Volatile storage owned by one browser-side Marmot account/device engine.
#[derive(Clone, Default)]
pub struct MemoryAccountStorage {
    inner: Arc<MemoryAccountStorageInner>,
}

impl MemoryAccountStorage {
    pub fn new() -> Self {
        Self::default()
    }

    fn app(&self) -> StorageResult<MutexGuard<'_, AppState>> {
        self.inner
            .app
            .lock()
            .map_err(|_| StorageError::Backend("memory application state lock poisoned".into()))
    }

    fn snapshots(&self) -> StorageResult<MutexGuard<'_, HashMap<(GroupId, String), Snapshot>>> {
        self.inner
            .snapshots
            .lock()
            .map_err(|_| StorageError::Backend("memory snapshot lock poisoned".into()))
    }

    fn clone_mls(&self) -> StorageResult<HashMap<Vec<u8>, Vec<u8>>> {
        self.inner
            .mls
            .values
            .read()
            .map(|values| values.clone())
            .map_err(|_| StorageError::Backend("OpenMLS memory storage lock poisoned".into()))
    }

    fn replace_mls(&self, replacement: HashMap<Vec<u8>, Vec<u8>>) -> StorageResult<()> {
        let mut values =
            self.inner.mls.values.write().map_err(|_| {
                StorageError::Backend("OpenMLS memory storage lock poisoned".into())
            })?;
        *values = replacement;
        Ok(())
    }

    /// Exports the complete app-owned storage aggregate, including OpenMLS
    /// values and rollback snapshots, for insertion into an encrypted SQLite
    /// checkpoint.
    pub fn export_state(&self) -> StorageResult<Vec<u8>> {
        let app_guard = self.app()?;
        let app = PersistedAppState::from_app(&app_guard);
        drop(app_guard);
        let mls = self.clone_mls()?.into_iter().collect();
        let snapshots = self
            .snapshots()?
            .iter()
            .map(|((group_id, name), snapshot)| PersistedSnapshot {
                group_id: group_id.clone(),
                name: name.clone(),
                app: PersistedAppState::from_app(&snapshot.app),
                mls: snapshot.mls.clone().into_iter().collect(),
            })
            .collect();
        let bytes = serde_json::to_vec(&PersistedStorage {
            schema_version: PERSISTED_STORAGE_SCHEMA_VERSION,
            app,
            mls,
            snapshots,
        })
        .map_err(|error| StorageError::Serialization(error.to_string()))?;
        if bytes.len() > MAX_PERSISTED_STORAGE_BYTES {
            return Err(StorageError::Backend(
                "persisted memory storage exceeds the browser checkpoint limit".into(),
            ));
        }
        Ok(bytes)
    }

    /// Reconstructs a complete storage aggregate from an authenticated
    /// checkpoint. The caller must decrypt/authenticate before this method.
    pub fn import_state(bytes: &[u8]) -> StorageResult<Self> {
        if bytes.is_empty() || bytes.len() > MAX_PERSISTED_STORAGE_BYTES {
            return Err(StorageError::Serialization(
                "persisted memory storage size is invalid".into(),
            ));
        }
        let persisted: PersistedStorage = serde_json::from_slice(bytes)
            .map_err(|error| StorageError::Serialization(error.to_string()))?;
        if persisted.schema_version != PERSISTED_STORAGE_SCHEMA_VERSION {
            return Err(StorageError::Serialization(
                "persisted memory storage schema is unsupported".into(),
            ));
        }

        let storage = Self::new();
        *storage.app()? = persisted.app.into_app();
        storage.replace_mls(persisted.mls.into_iter().collect())?;
        *storage.snapshots()? = persisted
            .snapshots
            .into_iter()
            .map(|snapshot| {
                (
                    (snapshot.group_id, snapshot.name),
                    Snapshot {
                        app: snapshot.app.into_app(),
                        mls: snapshot.mls.into_iter().collect(),
                    },
                )
            })
            .collect();
        Ok(storage)
    }
}

impl PersistedAppState {
    fn from_app(app: &AppState) -> Self {
        Self {
            groups: app.groups.values().cloned().collect(),
            messages: app.messages.clone(),
            queued_outbound: app.queued_outbound.clone(),
            leave_requests: app.leave_requests.values().cloned().collect(),
            welcomes: app.welcomes.clone(),
            member_capabilities: app
                .member_capabilities
                .iter()
                .map(|((group_id, member_id), capabilities)| {
                    (group_id.clone(), member_id.clone(), capabilities.clone())
                })
                .collect(),
            convergence_policies: app
                .convergence_policies
                .iter()
                .map(|(group_id, policy)| (group_id.clone(), policy.clone()))
                .collect(),
            validated_tree_markers: app
                .validated_tree_markers
                .iter()
                .map(|(group_id, marker)| (group_id.clone(), marker.clone()))
                .collect(),
            account_device_signers: app.account_device_signers.values().cloned().collect(),
        }
    }

    fn into_app(self) -> AppState {
        AppState {
            groups: self
                .groups
                .into_iter()
                .map(|group| (group.id.clone(), group))
                .collect(),
            messages: self.messages,
            queued_outbound: self.queued_outbound,
            leave_requests: self
                .leave_requests
                .into_iter()
                .map(|request| (request.group_id.clone(), request))
                .collect(),
            welcomes: self.welcomes,
            features: HashMap::new(),
            member_capabilities: self
                .member_capabilities
                .into_iter()
                .map(|(group_id, member_id, capabilities)| ((group_id, member_id), capabilities))
                .collect(),
            convergence_policies: self.convergence_policies.into_iter().collect(),
            validated_tree_markers: self.validated_tree_markers.into_iter().collect(),
            account_device_signers: self
                .account_device_signers
                .into_iter()
                .map(|binding| (binding.marmot_identity.clone(), binding))
                .collect(),
        }
    }
}

impl GroupStorage for MemoryAccountStorage {
    fn put_group(&self, group: &Group) -> StorageResult<()> {
        self.app()?.groups.insert(group.id.clone(), group.clone());
        Ok(())
    }

    fn get_group(&self, id: &GroupId) -> StorageResult<Group> {
        self.app()?
            .groups
            .get(id)
            .cloned()
            .ok_or(StorageError::NotFound)
    }

    fn delete_group(&self, id: &GroupId) -> StorageResult<()> {
        let mut app = self.app()?;
        if app.groups.remove(id).is_none() {
            return Err(StorageError::NotFound);
        }

        app.messages.retain(|record| &record.group_id != id);
        app.queued_outbound.retain(|record| &record.group_id != id);
        app.leave_requests.remove(id);
        app.welcomes.retain(|welcome| &welcome.group_id != id);
        app.member_capabilities
            .retain(|(group_id, _), _| group_id != id);
        app.convergence_policies.remove(id);
        app.validated_tree_markers.remove(id);
        drop(app);
        self.snapshots()?.retain(|(group_id, _), _| group_id != id);
        Ok(())
    }

    fn list_groups(&self) -> StorageResult<Vec<GroupId>> {
        let mut ids: Vec<_> = self.app()?.groups.keys().cloned().collect();
        ids.sort_by(|left, right| left.as_slice().cmp(right.as_slice()));
        Ok(ids)
    }
}

impl MessageStorage for MemoryAccountStorage {
    fn put_message(&self, record: &MessageRecord) -> StorageResult<()> {
        let mut app = self.app()?;
        if let Some(existing) = app.messages.iter_mut().find(|item| item.id == record.id) {
            *existing = record.clone();
        } else {
            app.messages.push(record.clone());
        }
        Ok(())
    }

    fn get_message(&self, id: &MessageId) -> StorageResult<MessageRecord> {
        self.app()?
            .messages
            .iter()
            .find(|record| &record.id == id)
            .cloned()
            .ok_or(StorageError::NotFound)
    }

    fn update_message_state(&self, id: &MessageId, new_state: MessageState) -> StorageResult<()> {
        let mut app = self.app()?;
        let record = app
            .messages
            .iter_mut()
            .find(|record| &record.id == id)
            .ok_or(StorageError::NotFound)?;
        record.state = new_state;
        Ok(())
    }

    fn list_messages(
        &self,
        group_id: &GroupId,
        at_or_after_epoch: EpochId,
    ) -> StorageResult<Vec<MessageRecord>> {
        Ok(self
            .app()?
            .messages
            .iter()
            .filter(|record| &record.group_id == group_id && record.epoch >= at_or_after_epoch)
            .cloned()
            .collect())
    }

    fn create_group_snapshot(&self, group_id: &GroupId, name: &str) -> StorageResult<()> {
        let snapshot = Snapshot {
            app: self.app()?.clone(),
            mls: self.clone_mls()?,
        };
        self.snapshots()?
            .insert((group_id.clone(), name.to_owned()), snapshot);
        Ok(())
    }

    fn list_group_snapshots(&self, group_id: &GroupId) -> StorageResult<Vec<String>> {
        let mut names: Vec<_> = self
            .snapshots()?
            .keys()
            .filter(|(id, _)| id == group_id)
            .map(|(_, name)| name.clone())
            .collect();
        names.sort();
        Ok(names)
    }

    fn rollback_group_to_snapshot(&self, group_id: &GroupId, name: &str) -> StorageResult<()> {
        let key = (group_id.clone(), name.to_owned());
        let snapshot = self
            .snapshots()?
            .get(&key)
            .cloned()
            .ok_or_else(|| StorageError::SnapshotMissing(name.to_owned()))?;
        *self.app()? = snapshot.app;
        self.replace_mls(snapshot.mls)
    }

    fn release_group_snapshot(&self, group_id: &GroupId, name: &str) -> StorageResult<()> {
        self.snapshots()?
            .remove(&(group_id.clone(), name.to_owned()))
            .ok_or_else(|| StorageError::SnapshotMissing(name.to_owned()))?;
        Ok(())
    }
}

impl OutboundIntentStorage for MemoryAccountStorage {
    fn put_queued_outbound_intent(&self, record: &QueuedOutboundIntent) -> StorageResult<()> {
        let mut app = self.app()?;
        if let Some(existing) = app
            .queued_outbound
            .iter_mut()
            .find(|item| item.id == record.id)
        {
            *existing = record.clone();
        } else {
            app.queued_outbound.push(record.clone());
        }
        Ok(())
    }

    fn list_queued_outbound_intents(
        &self,
        group_id: &GroupId,
    ) -> StorageResult<Vec<QueuedOutboundIntent>> {
        Ok(self
            .app()?
            .queued_outbound
            .iter()
            .filter(|record| &record.group_id == group_id)
            .cloned()
            .collect())
    }

    fn delete_queued_outbound_intent(&self, id: &MessageId) -> StorageResult<()> {
        let mut app = self.app()?;
        let index = app
            .queued_outbound
            .iter()
            .position(|record| &record.id == id)
            .ok_or(StorageError::NotFound)?;
        app.queued_outbound.remove(index);
        Ok(())
    }
}

impl LeaveRequestStorage for MemoryAccountStorage {
    fn put_leave_request(&self, request: &LeaveRequest) -> StorageResult<()> {
        self.app()?
            .leave_requests
            .insert(request.group_id.clone(), request.clone());
        Ok(())
    }

    fn leave_request(&self, group_id: &GroupId) -> StorageResult<Option<LeaveRequest>> {
        Ok(self.app()?.leave_requests.get(group_id).cloned())
    }

    fn clear_leave_request(&self, group_id: &GroupId) -> StorageResult<()> {
        self.app()?.leave_requests.remove(group_id);
        Ok(())
    }
}

impl WelcomeStorage for MemoryAccountStorage {
    fn put_welcome(&self, welcome: &PendingWelcome) -> StorageResult<()> {
        let mut app = self.app()?;
        if let Some(existing) = app
            .welcomes
            .iter_mut()
            .find(|item| item.message_id == welcome.message_id)
        {
            *existing = welcome.clone();
        } else {
            app.welcomes.push(welcome.clone());
        }
        Ok(())
    }

    fn take_welcome(&self, id: &MessageId) -> StorageResult<PendingWelcome> {
        let mut app = self.app()?;
        let index = app
            .welcomes
            .iter()
            .position(|welcome| &welcome.message_id == id)
            .ok_or(StorageError::NotFound)?;
        Ok(app.welcomes.remove(index))
    }

    fn list_welcomes(&self) -> StorageResult<Vec<PendingWelcome>> {
        Ok(self.app()?.welcomes.clone())
    }
}

impl CapabilityStorage for MemoryAccountStorage {
    fn register_feature(&self, feature: Feature, req: CapabilityRequirement) -> StorageResult<()> {
        self.app()?.features.insert(feature, req);
        Ok(())
    }

    fn feature_requirement(
        &self,
        feature: &Feature,
    ) -> StorageResult<Option<CapabilityRequirement>> {
        Ok(self.app()?.features.get(feature).cloned())
    }

    fn save_member_capabilities(
        &self,
        group_id: &GroupId,
        member: &Member,
        capabilities: GroupCapabilities,
    ) -> StorageResult<()> {
        self.app()?
            .member_capabilities
            .insert((group_id.clone(), member.id.clone()), capabilities);
        Ok(())
    }

    fn member_capabilities(
        &self,
        group_id: &GroupId,
        member_id: &MemberId,
    ) -> StorageResult<Option<GroupCapabilities>> {
        Ok(self
            .app()?
            .member_capabilities
            .get(&(group_id.clone(), member_id.clone()))
            .cloned())
    }
}

impl ConvergencePolicyStorage for MemoryAccountStorage {
    fn put_convergence_policy(&self, group_id: &GroupId, policy: &[u8]) -> StorageResult<()> {
        self.app()?
            .convergence_policies
            .insert(group_id.clone(), policy.to_vec());
        Ok(())
    }

    fn convergence_policy(&self, group_id: &GroupId) -> StorageResult<Option<Vec<u8>>> {
        Ok(self.app()?.convergence_policies.get(group_id).cloned())
    }
}

impl MemberValidationCacheStorage for MemoryAccountStorage {
    fn put_validated_tree_marker(&self, group_id: &GroupId, marker: &[u8]) -> StorageResult<()> {
        self.app()?
            .validated_tree_markers
            .insert(group_id.clone(), marker.to_vec());
        Ok(())
    }

    fn validated_tree_marker(&self, group_id: &GroupId) -> StorageResult<Option<Vec<u8>>> {
        Ok(self.app()?.validated_tree_markers.get(group_id).cloned())
    }
}

impl AccountDeviceSignerStorage for MemoryAccountStorage {
    fn put_account_device_signer(&self, binding: &AccountDeviceSignerBinding) -> StorageResult<()> {
        self.app()?
            .account_device_signers
            .insert(binding.marmot_identity.clone(), binding.clone());
        Ok(())
    }

    fn account_device_signer(
        &self,
        marmot_identity: &MemberId,
    ) -> StorageResult<Option<AccountDeviceSignerBinding>> {
        Ok(self
            .app()?
            .account_device_signers
            .get(marmot_identity)
            .cloned())
    }
}

impl StorageProvider for MemoryAccountStorage {
    type Mls = MemoryStorage;

    fn mls_storage(&self) -> &Self::Mls {
        &self.inner.mls
    }

    fn backend(&self) -> Backend {
        // MDK 0.9.4 exposes only `Backend::Sqlite`; the engine uses this value
        // for diagnostics, not storage dispatch. The concrete associated type
        // above remains the OpenMLS memory provider.
        Backend::Sqlite
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgka_traits::{
        capabilities::GroupCapabilities,
        group::Group,
        message::{MessageRecord, MessageState},
    };

    fn group(id: u8) -> Group {
        Group {
            id: GroupId::new([id]),
            name: format!("group-{id}"),
            description: String::new(),
            epoch: EpochId(0),
            members: Vec::new(),
            required_capabilities: GroupCapabilities::default(),
            removed: false,
            join_epoch: EpochId(0),
        }
    }

    #[test]
    fn preserves_order_and_upserts_records() {
        let storage = MemoryAccountStorage::new();
        storage.put_group(&group(2)).unwrap();
        storage.put_group(&group(1)).unwrap();
        assert_eq!(
            storage.list_groups().unwrap(),
            vec![GroupId::new([1]), GroupId::new([2])]
        );

        let first = MessageRecord {
            id: MessageId::new([1]),
            group_id: GroupId::new([1]),
            epoch: EpochId(0),
            state: MessageState::Created,
            payload: vec![1],
        };
        let second = MessageRecord {
            id: MessageId::new([2]),
            payload: vec![2],
            ..first.clone()
        };
        storage.put_message(&first).unwrap();
        storage.put_message(&second).unwrap();
        storage
            .update_message_state(&first.id, MessageState::Processed)
            .unwrap();

        let messages = storage.list_messages(&first.group_id, EpochId(0)).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>(),
            vec![first.id, second.id]
        );
        assert_eq!(messages[0].state, MessageState::Processed);
    }

    #[test]
    fn snapshot_rolls_back_application_and_openmls_memory() {
        let storage = MemoryAccountStorage::new();
        let original = group(1);
        storage.put_group(&original).unwrap();
        storage
            .inner
            .mls
            .values
            .write()
            .unwrap()
            .insert(vec![1], vec![2]);
        storage
            .create_group_snapshot(&original.id, "before")
            .unwrap();

        let mut changed = original.clone();
        changed.name = "changed".into();
        storage.put_group(&changed).unwrap();
        storage
            .inner
            .mls
            .values
            .write()
            .unwrap()
            .insert(vec![1], vec![3]);

        storage
            .rollback_group_to_snapshot(&original.id, "before")
            .unwrap();
        assert_eq!(storage.get_group(&original.id).unwrap(), original);
        assert_eq!(
            storage.inner.mls.values.read().unwrap().get(&vec![1]),
            Some(&vec![2])
        );
        storage
            .release_group_snapshot(&GroupId::new([1]), "before")
            .unwrap();
    }

    #[test]
    fn exports_and_imports_application_openmls_and_snapshots() {
        let storage = MemoryAccountStorage::new();
        let original = group(1);
        storage.put_group(&original).unwrap();
        storage
            .inner
            .mls
            .values
            .write()
            .unwrap()
            .insert(vec![4], vec![5]);
        storage
            .create_group_snapshot(&original.id, "durable")
            .unwrap();

        let restored =
            MemoryAccountStorage::import_state(&storage.export_state().unwrap()).unwrap();
        assert_eq!(restored.get_group(&original.id).unwrap(), original);
        assert_eq!(
            restored.inner.mls.values.read().unwrap().get(&vec![4]),
            Some(&vec![5])
        );
        assert_eq!(
            restored.list_group_snapshots(&GroupId::new([1])).unwrap(),
            vec!["durable"]
        );
    }
}
