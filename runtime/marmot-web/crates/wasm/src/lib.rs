use wasm_bindgen::prelude::*;

const MDK_GIT_REVISION: &str = "e391adc133a9b60e420da7a0446f014a180ac8d2";
const MDK_RELEASE: &str = "v0.9.4";
const RPC_SCHEMA_VERSION: u32 = 1;

/// Installs browser-friendly panic reporting before the runtime is constructed.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Reports the exact upstream implementation embedded in this Wasm artifact.
///
/// Returning a versioned JSON document keeps the first browser boundary small
/// while the typed request/response protocol is introduced in WP1.
#[wasm_bindgen]
pub fn runtime_info() -> String {
    let transport_vector = if transport_web::run_browser_transport_self_test().is_ok() {
        "passed"
    } else {
        "failed"
    };
    serde_json::json!({
        "backend": "rust-mdk",
        "mdkRelease": MDK_RELEASE,
        "mdkRevision": MDK_GIT_REVISION,
        "rpcSchemaVersion": RPC_SCHEMA_VERSION,
        "transportAdapter": "app-owned-rust",
        "transportVector": transport_vector,
    })
    .to_string()
}

/// Returns an opaque signed Nostr event for the Worker relay I/O probe.
/// The event is built and verified in Rust; JavaScript receives no MLS
/// plaintext or signing key.
#[wasm_bindgen]
pub fn relay_publish_fixture() -> Result<String, JsValue> {
    let (event_id, event_json) = transport_web::browser_relay_publish_fixture()
        .map_err(|_| JsValue::from_str("Rust could not build the relay fixture."))?;
    Ok(serde_json::json!({ "eventId": event_id, "eventJson": event_json }).to_string())
}

/// Returns the bounded Nostr filter set used by the Worker catch-up probe.
/// Production filters will be derived from each Rust-owned group routing
/// context; JavaScript remains responsible only for WebSocket framing.
#[wasm_bindgen]
pub fn relay_subscription_filters() -> String {
    serde_json::json!([{ "kinds": [transport_web::KIND_MARMOT_GROUP_MESSAGE] }]).to_string()
}

/// Compile-time evidence that the browser crate links the real MDK packages.
///
/// The public values remain opaque to JavaScript; protocol types will never be
/// exposed across the application boundary.
#[allow(dead_code)]
fn mdk_compile_guard(
    _: Option<cgka_traits::GroupId>,
    _: Option<cgka_traits::EngineError>,
    _: Option<cgka_engine::FeatureRegistry>,
    _: Option<transport_web::NostrWebPeeler>,
) {
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_info_pins_the_reviewed_mdk_release() {
        let info: serde_json::Value =
            serde_json::from_str(&runtime_info()).expect("runtime info is valid JSON");

        assert_eq!(info["backend"], "rust-mdk");
        assert_eq!(info["mdkRelease"], MDK_RELEASE);
        assert_eq!(info["mdkRevision"], MDK_GIT_REVISION);
        assert_eq!(info["rpcSchemaVersion"], RPC_SCHEMA_VERSION);
        assert_eq!(info["transportAdapter"], "app-owned-rust");
        assert_eq!(info["transportVector"], "passed");
    }

    #[test]
    fn relay_fixture_is_signed_and_bound_to_its_id() {
        let fixture: serde_json::Value = serde_json::from_str(
            &relay_publish_fixture().expect("Rust relay fixture is available"),
        )
        .expect("relay fixture is JSON");
        let event: serde_json::Value = serde_json::from_str(
            fixture["eventJson"]
                .as_str()
                .expect("relay event is encoded JSON"),
        )
        .expect("relay event is JSON");
        assert_eq!(fixture["eventId"], event["id"]);
        assert_eq!(event["kind"], KIND_MARMOT_GROUP_MESSAGE_FOR_TEST);
        assert!(event["sig"].as_str().is_some_and(|sig| sig.len() == 128));
    }

    #[test]
    fn relay_subscription_filter_targets_marmot_group_events() {
        let filters: serde_json::Value =
            serde_json::from_str(&relay_subscription_filters()).expect("filters are JSON");
        assert_eq!(
            filters,
            serde_json::json!([{ "kinds": [KIND_MARMOT_GROUP_MESSAGE_FOR_TEST] }])
        );
    }
}

#[cfg(test)]
const KIND_MARMOT_GROUP_MESSAGE_FOR_TEST: u64 = 445;
