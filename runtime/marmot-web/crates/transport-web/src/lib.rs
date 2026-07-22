//! Browser-safe Nostr envelope adapter for the unmodified MDK engine.
//!
//! MDK owns every MLS and CGKA transition. This crate implements only the
//! transport-edge contract exposed by [`cgka_traits::TransportPeeler`]. It
//! deliberately uses concrete [`nostr::Keys`] and synchronous Nostr crypto so
//! its trait futures remain `Send` on `wasm32-unknown-unknown`.

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use cgka_traits::engine::WelcomeMetadata;
use cgka_traits::error::PeelerError;
use cgka_traits::group_context::GroupContextSnapshot;
use cgka_traits::ingest::{PeeledContent, PeeledMessage};
use cgka_traits::peeler::{GroupMessageMetadata, TransportPeeler};
use cgka_traits::transport::{
    EncryptedPayload, Timestamp as TransportTimestamp, TransportEnvelope, TransportMessage,
    TransportSource,
};
use cgka_traits::types::{GroupId, MemberId, MessageId};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use nostr::nips::nip44;
use nostr::{
    Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, RelayUrl, Tag, TagKind, Timestamp,
    UnsignedEvent,
};
use rand::RngCore;
use std::fmt;

pub const DEFAULT_EXPORTER_LABEL: &str = "marmot/group-event";
pub const KIND_MARMOT_GROUP_MESSAGE: u16 = 445;
pub const KIND_MARMOT_WELCOME_RUMOR: u16 = 444;
pub const NOSTR_SOURCE: &str = "nostr";

const EXPIRATION_TAG: &str = "expiration";
const GROUP_AAD: &[u8] = b"";
const GROUP_KEY_LEN: usize = 32;
const GROUP_TAG: &str = "h";
const KEY_PACKAGE_EVENT_TAG: &str = "e";
const MAX_WELCOME_RELAYS: usize = 16;
const MAX_WELCOME_RELAY_URL_LEN: usize = 512;
const MIN_GROUP_CONTENT_LEN: usize = 12 + 16;
const NONCE_LEN: usize = 12;
const RECIPIENT_TAG: &str = "p";
const WELCOME_RELAYS_TAG: &str = "relays";

/// A browser-safe implementation of MDK's Nostr transport boundary.
///
/// Account keys remain in the Rust Worker. `Debug` intentionally reveals only
/// whether Welcome support is configured.
#[derive(Clone)]
pub struct NostrWebPeeler {
    exporter_label: String,
    welcome_keys: Option<Keys>,
}

impl NostrWebPeeler {
    pub fn new() -> Self {
        Self {
            exporter_label: DEFAULT_EXPORTER_LABEL.into(),
            welcome_keys: None,
        }
    }

    pub fn with_exporter_label(mut self, label: impl Into<String>) -> Self {
        self.exporter_label = label.into();
        self
    }

    pub fn with_welcome_keys(mut self, keys: Keys) -> Self {
        self.welcome_keys = Some(keys);
        self
    }

    fn welcome_keys(&self) -> Result<&Keys, PeelerError> {
        self.welcome_keys
            .as_ref()
            .ok_or_else(|| PeelerError::MissingContext {
                label: "nostr_welcome_keys".into(),
            })
    }

    fn group_key<'a>(&self, ctx: &'a GroupContextSnapshot) -> Result<&'a [u8], PeelerError> {
        let key = ctx.exporter_secret(&self.exporter_label).ok_or_else(|| {
            PeelerError::MissingContext {
                label: self.exporter_label.clone(),
            }
        })?;
        if key.len() != GROUP_KEY_LEN {
            return Err(PeelerError::MissingContext {
                label: format!("{} (must be 32 bytes)", self.exporter_label),
            });
        }
        Ok(key)
    }

    fn wrap_group(
        &self,
        payload: &EncryptedPayload,
        ctx: &GroupContextSnapshot,
        metadata: Option<&GroupMessageMetadata>,
    ) -> Result<TransportMessage, PeelerError> {
        if !payload.aad.is_empty() {
            return Err(PeelerError::WrapFailed(
                "Nostr group wrapping requires empty AAD".into(),
            ));
        }
        let group_id = ctx
            .transport_group_id()
            .filter(|value| value.len() == 32)
            .ok_or_else(|| PeelerError::MissingContext {
                label: "32-byte transport_group_id".into(),
            })?;
        let cipher = ChaCha20Poly1305::new_from_slice(self.group_key(ctx)?)
            .map_err(|_| PeelerError::WrapFailed("invalid group key".into()))?;
        let mut nonce = [0_u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &payload.ciphertext,
                    aad: GROUP_AAD,
                },
            )
            .map_err(|_| PeelerError::WrapFailed("group encryption failed".into()))?;
        let mut framed = Vec::with_capacity(nonce.len() + ciphertext.len());
        framed.extend_from_slice(&nonce);
        framed.extend_from_slice(&ciphertext);

        let mut tags = vec![Tag::custom(
            TagKind::custom(GROUP_TAG),
            [hex::encode(group_id)],
        )];
        if let Some(expiration) = metadata
            .map(GroupMessageMetadata::expiration_timestamp)
            .transpose()
            .map_err(|_| PeelerError::WrapFailed("invalid group expiration metadata".into()))?
            .flatten()
        {
            tags.push(Tag::custom(
                TagKind::custom(EXPIRATION_TAG),
                [expiration.to_string()],
            ));
        }

        let mut builder = EventBuilder::new(
            Kind::Custom(KIND_MARMOT_GROUP_MESSAGE),
            BASE64_STANDARD.encode(framed),
        )
        .tags(tags);
        if let Some(created_at) = metadata.and_then(GroupMessageMetadata::outer_created_at) {
            builder = builder.custom_created_at(Timestamp::from_secs(created_at));
        }
        let event = builder
            .sign_with_keys(&Keys::generate())
            .map_err(|_| PeelerError::WrapFailed("group event signing failed".into()))?;
        event_to_transport_message(&event)
    }
}

impl Default for NostrWebPeeler {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for NostrWebPeeler {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NostrWebPeeler")
            .field("exporter_label", &self.exporter_label)
            .field("welcome_keys_configured", &self.welcome_keys.is_some())
            .finish()
    }
}

#[async_trait]
impl TransportPeeler for NostrWebPeeler {
    async fn peel_group_message(
        &self,
        msg: &TransportMessage,
        ctx: &GroupContextSnapshot,
    ) -> Result<PeeledMessage, PeelerError> {
        let event = event_from_transport_message(msg)?;
        if event.kind.as_u16() != KIND_MARMOT_GROUP_MESSAGE {
            return Err(PeelerError::Malformed("expected Nostr kind 445".into()));
        }
        let route = single_tag_value(&event, GROUP_TAG)?;
        let route = decode_hex_exact("group h tag", route, 32)?;
        ensure_group_envelope(msg, &route)?;

        let framed = BASE64_STANDARD
            .decode(event.content.as_bytes())
            .map_err(|_| PeelerError::Malformed("kind-445 content is not base64".into()))?;
        if framed.len() < MIN_GROUP_CONTENT_LEN {
            return Err(PeelerError::Malformed(
                "kind-445 content is shorter than nonce plus authentication tag".into(),
            ));
        }
        let (nonce, ciphertext) = framed.split_at(NONCE_LEN);
        let cipher = ChaCha20Poly1305::new_from_slice(self.group_key(ctx)?)
            .map_err(|_| PeelerError::DecryptFailed)?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: GROUP_AAD,
                },
            )
            .map_err(|_| PeelerError::DecryptFailed)?;

        Ok(PeeledMessage {
            id: msg.id.clone(),
            group_id: Some(GroupId::new(route)),
            sender: None,
            content: PeeledContent::MlsMessage { bytes: plaintext },
            origin: msg.clone(),
        })
    }

    async fn peel_welcome(&self, msg: &TransportMessage) -> Result<PeeledMessage, PeelerError> {
        let keys = self.welcome_keys()?;
        let gift_wrap = event_from_transport_message(msg)?;
        if gift_wrap.kind != Kind::GiftWrap {
            return Err(PeelerError::Malformed(
                "expected Nostr kind 1059 gift wrap".into(),
            ));
        }
        let recipient = decode_hex_exact(
            "recipient p tag",
            single_tag_value(&gift_wrap, RECIPIENT_TAG)?,
            32,
        )?;
        ensure_welcome_envelope(msg, &recipient)?;

        let rumor = unwrap_gift_wrap(keys, &gift_wrap)?;
        if rumor.kind != Kind::Custom(KIND_MARMOT_WELCOME_RUMOR) {
            return Err(PeelerError::Malformed(
                "gift wrap did not contain a Marmot Welcome".into(),
            ));
        }
        decode_hex_exact(
            "welcome e tag",
            single_tag_value_unsigned(&rumor, KEY_PACKAGE_EVENT_TAG)?,
            32,
        )?;
        let relays = single_tag_values_unsigned(&rumor, WELCOME_RELAYS_TAG)?;
        validate_relays(&relays)?;
        let bytes = BASE64_STANDARD
            .decode(rumor.content.as_bytes())
            .map_err(|_| PeelerError::Malformed("Welcome content is not base64".into()))?;
        if bytes.is_empty() {
            return Err(PeelerError::Malformed("Welcome content is empty".into()));
        }

        Ok(PeeledMessage {
            id: msg.id.clone(),
            group_id: None,
            sender: Some(MemberId::new(rumor.pubkey.to_bytes().to_vec())),
            content: PeeledContent::Welcome { bytes },
            origin: msg.clone(),
        })
    }

    async fn wrap_group_message(
        &self,
        payload: &EncryptedPayload,
        ctx: &GroupContextSnapshot,
    ) -> Result<TransportMessage, PeelerError> {
        self.wrap_group(payload, ctx, None)
    }

    async fn wrap_group_message_with_metadata(
        &self,
        payload: &EncryptedPayload,
        ctx: &GroupContextSnapshot,
        metadata: &GroupMessageMetadata,
    ) -> Result<TransportMessage, PeelerError> {
        self.wrap_group(payload, ctx, Some(metadata))
    }

    async fn wrap_welcome(
        &self,
        _payload: &EncryptedPayload,
        _recipient: &MemberId,
    ) -> Result<TransportMessage, PeelerError> {
        Err(PeelerError::MissingContext {
            label: "welcome_metadata".into(),
        })
    }

    async fn wrap_welcome_with_metadata(
        &self,
        payload: &EncryptedPayload,
        recipient: &MemberId,
        metadata: &WelcomeMetadata,
    ) -> Result<TransportMessage, PeelerError> {
        if !payload.aad.is_empty() {
            return Err(PeelerError::WrapFailed(
                "Nostr Welcome wrapping requires empty AAD".into(),
            ));
        }
        if payload.ciphertext.is_empty() {
            return Err(PeelerError::WrapFailed("Welcome content is empty".into()));
        }
        let sender = self.welcome_keys()?;
        let recipient = PublicKey::from_slice(recipient.as_slice())
            .map_err(|_| PeelerError::WrapFailed("recipient is not a Nostr public key".into()))?;
        let relay_values: Vec<&str> = metadata.relays.iter().map(|relay| relay.as_str()).collect();
        validate_relays(&relay_values)?;
        if metadata.key_package_event_id.as_slice().len() != 32 {
            return Err(PeelerError::WrapFailed(
                "key-package event id must be 32 bytes".into(),
            ));
        }

        let rumor = EventBuilder::new(
            Kind::Custom(KIND_MARMOT_WELCOME_RUMOR),
            BASE64_STANDARD.encode(&payload.ciphertext),
        )
        .tags([
            Tag::custom(
                TagKind::custom(KEY_PACKAGE_EVENT_TAG),
                [hex::encode(metadata.key_package_event_id.as_slice())],
            ),
            Tag::custom(
                TagKind::custom(WELCOME_RELAYS_TAG),
                metadata.relays.iter().map(|relay| relay.as_str()),
            ),
        ])
        .build(sender.public_key());
        let event = wrap_gift(sender, &recipient, rumor)?;
        event_to_transport_message(&event)
    }
}

/// Convert a verified relay event into the exact transport value MDK ingests.
pub fn event_to_transport_message(event: &Event) -> Result<TransportMessage, PeelerError> {
    event
        .verify()
        .map_err(|_| PeelerError::Malformed("Nostr event verification failed".into()))?;
    let envelope = match event.kind.as_u16() {
        KIND_MARMOT_GROUP_MESSAGE => TransportEnvelope::GroupMessage {
            transport_group_id: decode_hex_exact(
                "group h tag",
                single_tag_value(event, GROUP_TAG)?,
                32,
            )?,
        },
        value if value == Kind::GiftWrap.as_u16() => TransportEnvelope::Welcome {
            recipient: MemberId::new(decode_hex_exact(
                "recipient p tag",
                single_tag_value(event, RECIPIENT_TAG)?,
                32,
            )?),
        },
        _ => {
            return Err(PeelerError::Malformed(
                "unsupported Nostr event kind".into(),
            ));
        }
    };

    Ok(TransportMessage {
        id: MessageId::new(event.id.to_bytes().to_vec()),
        payload: event.as_json().into_bytes(),
        timestamp: TransportTimestamp(event.created_at.as_secs()),
        causal_deps: Vec::new(),
        source: TransportSource(NOSTR_SOURCE.into()),
        envelope,
    })
}

/// Parse, verify, and bind a transport payload back to its routing envelope.
pub fn event_from_transport_message(msg: &TransportMessage) -> Result<Event, PeelerError> {
    if msg.source.0 != NOSTR_SOURCE {
        return Err(PeelerError::Malformed("unexpected transport source".into()));
    }
    let event = Event::from_json(&msg.payload)
        .map_err(|_| PeelerError::Malformed("invalid Nostr event JSON".into()))?;
    event
        .verify()
        .map_err(|_| PeelerError::Malformed("Nostr event verification failed".into()))?;
    if event.id.as_bytes() != msg.id.as_slice() {
        return Err(PeelerError::Malformed(
            "Nostr event id does not match transport id".into(),
        ));
    }
    Ok(event)
}

fn wrap_gift(
    sender: &Keys,
    recipient: &PublicKey,
    mut rumor: UnsignedEvent,
) -> Result<Event, PeelerError> {
    rumor.ensure_id();
    let seal_content = nip44::encrypt(
        sender.secret_key(),
        recipient,
        rumor.as_json(),
        nip44::Version::V2,
    )
    .map_err(|_| PeelerError::WrapFailed("Welcome seal encryption failed".into()))?;
    let seal = EventBuilder::new(Kind::Seal, seal_content)
        .custom_created_at(Timestamp::tweaked(
            nostr::nips::nip59::RANGE_RANDOM_TIMESTAMP_TWEAK,
        ))
        .sign_with_keys(sender)
        .map_err(|_| PeelerError::WrapFailed("Welcome seal signing failed".into()))?;
    EventBuilder::gift_wrap_from_seal(recipient, &seal, [])
        .map_err(|_| PeelerError::WrapFailed("Welcome gift wrapping failed".into()))
}

fn unwrap_gift_wrap(keys: &Keys, gift_wrap: &Event) -> Result<UnsignedEvent, PeelerError> {
    let seal_json = nip44::decrypt(keys.secret_key(), &gift_wrap.pubkey, &gift_wrap.content)
        .map_err(|_| PeelerError::DecryptFailed)?;
    let seal = Event::from_json(seal_json).map_err(|_| PeelerError::DecryptFailed)?;
    if seal.kind != Kind::Seal || seal.verify().is_err() {
        return Err(PeelerError::DecryptFailed);
    }
    let rumor_json = nip44::decrypt(keys.secret_key(), &seal.pubkey, &seal.content)
        .map_err(|_| PeelerError::DecryptFailed)?;
    let rumor = UnsignedEvent::from_json(rumor_json).map_err(|_| PeelerError::DecryptFailed)?;
    if rumor.pubkey != seal.pubkey {
        return Err(PeelerError::DecryptFailed);
    }
    Ok(rumor)
}

fn ensure_group_envelope(msg: &TransportMessage, route: &[u8]) -> Result<(), PeelerError> {
    match &msg.envelope {
        TransportEnvelope::GroupMessage { transport_group_id } if transport_group_id == route => {
            Ok(())
        }
        _ => Err(PeelerError::Malformed(
            "group route does not match transport envelope".into(),
        )),
    }
}

fn ensure_welcome_envelope(msg: &TransportMessage, recipient: &[u8]) -> Result<(), PeelerError> {
    match &msg.envelope {
        TransportEnvelope::Welcome {
            recipient: envelope_recipient,
        } if envelope_recipient.as_slice() == recipient => Ok(()),
        _ => Err(PeelerError::Malformed(
            "Welcome recipient does not match transport envelope".into(),
        )),
    }
}

fn single_tag_value<'a>(event: &'a Event, name: &str) -> Result<&'a str, PeelerError> {
    let tags: Vec<&[String]> = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|tag| tag.first().is_some_and(|value| value == name))
        .collect();
    exactly_one_tag_value(&tags, name)
}

fn single_tag_value_unsigned<'a>(
    event: &'a UnsignedEvent,
    name: &str,
) -> Result<&'a str, PeelerError> {
    let tags: Vec<&[String]> = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|tag| tag.first().is_some_and(|value| value == name))
        .collect();
    exactly_one_tag_value(&tags, name)
}

fn single_tag_values_unsigned<'a>(
    event: &'a UnsignedEvent,
    name: &str,
) -> Result<Vec<&'a str>, PeelerError> {
    let tags: Vec<&[String]> = event
        .tags
        .iter()
        .map(Tag::as_slice)
        .filter(|tag| tag.first().is_some_and(|value| value == name))
        .collect();
    if tags.len() != 1 {
        return Err(PeelerError::Malformed(format!(
            "expected exactly one {name} tag"
        )));
    }
    Ok(tags[0].iter().skip(1).map(String::as_str).collect())
}

fn exactly_one_tag_value<'a>(tags: &[&'a [String]], name: &str) -> Result<&'a str, PeelerError> {
    if tags.len() != 1 {
        return Err(PeelerError::Malformed(format!(
            "expected exactly one {name} tag"
        )));
    }
    tags[0]
        .get(1)
        .map(String::as_str)
        .ok_or_else(|| PeelerError::Malformed(format!("{name} tag has no value")))
}

fn validate_relays(relays: &[&str]) -> Result<(), PeelerError> {
    if relays.is_empty() || relays.len() > MAX_WELCOME_RELAYS {
        return Err(PeelerError::Malformed(
            "Welcome relay count is outside the supported range".into(),
        ));
    }
    for relay in relays {
        if relay.len() > MAX_WELCOME_RELAY_URL_LEN || RelayUrl::parse(relay).is_err() {
            return Err(PeelerError::Malformed(
                "Welcome relay URL is invalid".into(),
            ));
        }
    }
    Ok(())
}

fn decode_hex_exact(label: &str, value: &str, length: usize) -> Result<Vec<u8>, PeelerError> {
    let bytes = hex::decode(value)
        .map_err(|_| PeelerError::Malformed(format!("{label} is not valid hex")))?;
    if bytes.len() != length {
        return Err(PeelerError::Malformed(format!(
            "{label} must be {length} bytes"
        )));
    }
    Ok(bytes)
}

/// Executes both browser transport envelope paths without a network.
///
/// The Wasm bootstrap calls this proof before reporting the runtime ready, so
/// Chromium verifies actual kind-445 and NIP-59 crypto rather than merely
/// loading a linked symbol.
pub fn run_browser_transport_self_test() -> Result<(), PeelerError> {
    use cgka_traits::group_context::GroupContextSnapshot;
    use cgka_traits::transport_adapter::TransportEndpoint;
    use cgka_traits::types::EpochId;
    use std::collections::HashMap;

    futures::executor::block_on(async {
        let group_payload = EncryptedPayload {
            ciphertext: b"browser MDK transport vector".to_vec(),
            aad: Vec::new(),
        };
        let group_context = GroupContextSnapshot::new(
            EpochId(1),
            HashMap::from([(DEFAULT_EXPORTER_LABEL.into(), vec![0x5a; 32])]),
            Some(vec![0x6b; 32]),
        );
        let group_peeler = NostrWebPeeler::new();
        let group_event = group_peeler
            .wrap_group_message(&group_payload, &group_context)
            .await?;
        let group_result = group_peeler
            .peel_group_message(&group_event, &group_context)
            .await?;
        if group_result.content
            != (PeeledContent::MlsMessage {
                bytes: group_payload.ciphertext,
            })
        {
            return Err(PeelerError::Malformed(
                "browser group transport vector did not round trip".into(),
            ));
        }

        let sender = Keys::generate();
        let receiver = Keys::generate();
        let recipient = MemberId::new(receiver.public_key().to_bytes().to_vec());
        let welcome_payload = EncryptedPayload {
            ciphertext: b"browser MDK Welcome vector".to_vec(),
            aad: Vec::new(),
        };
        let welcome_metadata = WelcomeMetadata {
            key_package_event_id: MessageId::new(vec![0x7c; 32]),
            relays: vec![TransportEndpoint("wss://vector.example".into())],
        };
        let welcome_event = NostrWebPeeler::new()
            .with_welcome_keys(sender)
            .wrap_welcome_with_metadata(&welcome_payload, &recipient, &welcome_metadata)
            .await?;
        let welcome_result = NostrWebPeeler::new()
            .with_welcome_keys(receiver)
            .peel_welcome(&welcome_event)
            .await?;
        if welcome_result.content
            != (PeeledContent::Welcome {
                bytes: welcome_payload.ciphertext,
            })
        {
            return Err(PeelerError::Malformed(
                "browser Welcome transport vector did not round trip".into(),
            ));
        }

        Ok(())
    })
}

/// Produces one signed, encrypted kind-445 event for the browser relay I/O
/// vector. Rust constructs and verifies the event; the Worker host only
/// forwards its opaque JSON and matches the relay receipt to its id.
pub fn browser_relay_publish_fixture() -> Result<(String, String), PeelerError> {
    use cgka_traits::types::EpochId;
    use std::collections::HashMap;

    futures::executor::block_on(async {
        let payload = EncryptedPayload {
            ciphertext: b"browser relay fixture MLS bytes".to_vec(),
            aad: Vec::new(),
        };
        let context = GroupContextSnapshot::new(
            EpochId(1),
            HashMap::from([(DEFAULT_EXPORTER_LABEL.into(), vec![0x5a; 32])]),
            Some(vec![0x6b; 32]),
        );
        let message = NostrWebPeeler::new()
            .wrap_group_message(&payload, &context)
            .await?;
        let event = event_from_transport_message(&message)?;
        Ok((event.id.to_hex(), event.as_json()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgka_traits::engine::WelcomeMetadata;
    use cgka_traits::group_context::GroupContextSnapshot;
    use cgka_traits::ingest::PeeledContent;
    use cgka_traits::peeler::TransportPeeler;
    use cgka_traits::transport::EncryptedPayload;
    use cgka_traits::transport_adapter::TransportEndpoint;
    use cgka_traits::types::EpochId;
    use std::collections::HashMap;
    use transport_nostr_peeler::NostrMlsPeeler;

    #[tokio::test]
    async fn group_messages_cross_the_native_boundary_both_directions() {
        let context = group_context();
        let payload = EncryptedPayload {
            ciphertext: b"real MLS bytes".to_vec(),
            aad: Vec::new(),
        };
        let web = NostrWebPeeler::new();
        let native = NostrMlsPeeler::new();

        let web_event = web
            .wrap_group_message(&payload, &context)
            .await
            .expect("web wrap");
        let native_result = native
            .peel_group_message(&web_event, &context)
            .await
            .expect("native peel");
        assert_eq!(
            native_result.content,
            PeeledContent::MlsMessage {
                bytes: payload.ciphertext.clone()
            }
        );

        let native_event = native
            .wrap_group_message(&payload, &context)
            .await
            .expect("native wrap");
        let web_result = web
            .peel_group_message(&native_event, &context)
            .await
            .expect("web peel");
        assert_eq!(
            web_result.content,
            PeeledContent::MlsMessage {
                bytes: payload.ciphertext
            }
        );
    }

    #[tokio::test]
    async fn welcomes_cross_the_native_boundary_both_directions() {
        let sender = sender_keys();
        let receiver = receiver_keys();
        let recipient = MemberId::new(receiver.public_key().to_bytes().to_vec());
        let payload = EncryptedPayload {
            ciphertext: b"real MLS Welcome bytes".to_vec(),
            aad: Vec::new(),
        };
        let metadata = welcome_metadata();
        let web_sender = NostrWebPeeler::new().with_welcome_keys(sender.clone());
        let web_receiver = NostrWebPeeler::new().with_welcome_keys(receiver.clone());
        let native_sender = NostrMlsPeeler::new().with_welcome_signer(sender);
        let native_receiver = NostrMlsPeeler::new().with_welcome_signer(receiver);

        let web_event = web_sender
            .wrap_welcome_with_metadata(&payload, &recipient, &metadata)
            .await
            .expect("web wrap");
        let native_result = native_receiver
            .peel_welcome(&web_event)
            .await
            .expect("native peel");
        assert_eq!(
            native_result.content,
            PeeledContent::Welcome {
                bytes: payload.ciphertext.clone()
            }
        );

        let native_event = native_sender
            .wrap_welcome_with_metadata(&payload, &recipient, &metadata)
            .await
            .expect("native wrap");
        let web_result = web_receiver
            .peel_welcome(&native_event)
            .await
            .expect("web peel");
        assert_eq!(
            web_result.content,
            PeeledContent::Welcome {
                bytes: payload.ciphertext
            }
        );
    }

    fn group_context() -> GroupContextSnapshot {
        GroupContextSnapshot::new(
            EpochId(9),
            HashMap::from([(DEFAULT_EXPORTER_LABEL.into(), vec![0x7a; 32])]),
            Some(vec![0x99; 32]),
        )
    }

    fn welcome_metadata() -> WelcomeMetadata {
        WelcomeMetadata {
            key_package_event_id: MessageId::new(vec![0x44; 32]),
            relays: vec![
                TransportEndpoint("wss://group-a.example".into()),
                TransportEndpoint("wss://group-b.example".into()),
            ],
        }
    }

    fn test_keys(byte: u8) -> Keys {
        Keys::parse(&hex::encode([byte; 32])).expect("valid deterministic test key")
    }

    fn sender_keys() -> Keys {
        test_keys(0x11)
    }

    fn receiver_keys() -> Keys {
        test_keys(0x22)
    }
}
