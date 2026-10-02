use matrix_sdk::{
    Client, Room, RoomMemberships,
    config::{SyncSettings, SyncToken},
    deserialized_responses::{TimelineEvent, VerificationState},
    ruma::{
        OwnedDeviceId, OwnedRoomId, OwnedTransactionId, OwnedUserId,
        events::room::message::RoomMessageEventContent,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn health_report(state: &str, fault: Option<&str>, last_sync: Option<u64>, inbox: &Inbox) -> Value {
    let mut value = json!({"state":state,"pendingInbox":inbox.entries.iter().filter(|e| !e.complete).count(),"exhaustedInbox":inbox.entries.iter().filter(|e| !e.complete && e.attempts >= 10).count(),"historyRecovery":inbox.recovery.is_some()});
    if let Some(fault) = fault {
        value["fault"] = json!(fault);
    }
    if let Some(timestamp) = last_sync {
        value["lastSyncAt"] = json!(timestamp);
    }
    value
}
async fn report_health(
    http: &matrix_sdk::reqwest::Client,
    config: &ConnectorConfig,
    token: &str,
    report: Value,
) {
    // Bounded best effort. Controller failures become stale observations, never
    // plaintext fallback, application acknowledgment or device trust evidence.
    let _ = http
        .post(format!(
            "{}/api/v1/human/health",
            config.controller_url.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(3))
        .bearer_auth(token)
        .json(&report)
        .send()
        .await;
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct ConnectorConfig {
    pub homeserver: String,
    pub room_id: OwnedRoomId,
    pub own_user: OwnedUserId,
    pub own_device: OwnedDeviceId,
    pub allowed_users: Vec<OwnedUserId>,
    pub state_dir: PathBuf,
    pub session_file: PathBuf,
    pub passphrase_file: PathBuf,
    pub controller_url: String,
    pub controller_token_file: PathBuf,
}
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(deny_unknown_fields)]
struct Inbox {
    cursor: Option<String>,
    entries: Vec<InboxEntry>,
    #[serde(default)]
    trust_fault: bool,
    #[serde(default)]
    recovery: Option<HistoryRecovery>,
    #[serde(default)]
    recent_event_ids: Vec<String>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct HistoryRecovery {
    next_cursor: String,
    from: String,
    anchors: Vec<String>,
    pages: u32,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct InboxEntry {
    event: TimelineEvent,
    attempts: u8,
    complete: bool,
}

pub(crate) fn atomic_private(path: &Path, data: &[u8]) -> Result<()> {
    let temp = path.with_extension("new");
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(info) = fs::symlink_metadata(&temp) {
        if !info.is_file() || info.file_type().is_symlink() {
            return Err("Temporary inbox path is not a regular file".into());
        }
        fs::remove_file(&temp)?;
    }
    let mut file = options.open(&temp)?;
    file.write_all(data)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    fs::File::open(path.parent().ok_or("Missing parent")?)?.sync_all()?;
    Ok(())
}
pub(crate) fn private_text(path: &Path) -> Result<String> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.file_type().is_symlink() || fs::canonicalize(path)? != path {
        return Err("Private reference must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        if info.uid() != unsafe { libc::geteuid() } {
            return Err("Private reference must belong to the current user".into());
        }
        if info.permissions().mode() & 0o077 != 0 {
            return Err("Private reference permissions must be restrictive".into());
        }
    }
    Ok(fs::read_to_string(path)?.trim().to_owned())
}
impl Inbox {
    // Stage the full SDK batch and its replay cursor in one durable replacement.
    // The in-memory cursor changes only after that replacement succeeds.
    fn stage(
        &mut self,
        path: &Path,
        cursor: String,
        events: &[TimelineEvent],
        limited: bool,
        allowed: &[OwnedUserId],
        own: &OwnedUserId,
    ) -> Result<()> {
        if limited {
            return Err(
                "Limited timeline requires history recovery; application cursor was not advanced"
                    .into(),
            );
        }
        self.stage_optional(path, Some(cursor), events, allowed, own)
    }
    fn stage_optional(
        &mut self,
        path: &Path,
        cursor: Option<String>,
        events: &[TimelineEvent],
        allowed: &[OwnedUserId],
        own: &OwnedUserId,
    ) -> Result<()> {
        let mut next = self.clone();
        let mut ids: BTreeSet<String> = next
            .entries
            .iter()
            .filter_map(|e| e.event.raw().get_field::<String>("event_id").ok().flatten())
            .collect();
        ids.extend(next.recent_event_ids.iter().cloned());
        for event in events {
            let raw: Value = serde_json::from_str(event.raw().json().get())?;
            if raw["type"] == "m.room.member"
                && matches!(
                    raw["content"]["membership"].as_str(),
                    Some("join" | "invite")
                )
            {
                let member = raw["state_key"]
                    .as_str()
                    .ok_or("Member event is missing its identity")?;
                if member != own.as_str() && !allowed.iter().any(|user| user.as_str() == member) {
                    next.trust_fault = true;
                }
            }
            if let Some(id) = event.raw().get_field::<String>("event_id")? {
                if !next.recent_event_ids.contains(&id) {
                    next.recent_event_ids.push(id.clone());
                }
                if ids.insert(id) {
                    next.entries.push(InboxEntry {
                        event: event.clone(),
                        attempts: 0,
                        complete: false,
                    });
                }
            }
        }
        if next.recent_event_ids.len() > 1000 {
            next.recent_event_ids
                .drain(..next.recent_event_ids.len() - 1000);
        }
        if next.entries.len() > 10000 {
            return Err("Inbox capacity exceeded; cursor was not advanced".into());
        }
        next.cursor = cursor;
        next.entries.sort_by_key(|entry| {
            (
                entry
                    .event
                    .raw()
                    .get_field::<u64>("origin_server_ts")
                    .ok()
                    .flatten()
                    .unwrap_or(u64::MAX),
                entry
                    .event
                    .raw()
                    .get_field::<String>("event_id")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            )
        });
        let bytes = serde_json::to_vec(&next)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("Inbox byte capacity exceeded; cursor was not advanced".into());
        }
        atomic_private(path, &bytes)?;
        *self = next;
        Ok(())
    }
}
pub fn parse_command(body: &str, event_id: &str, timestamp: u64) -> Option<Value> {
    if body.len() > 64000 || !body.starts_with('!') {
        return None;
    }
    let (verb, args) = body.split_once(' ').unwrap_or((body, ""));
    let args = args.trim();
    let mut command =
        json!({"eventId":event_id,"timestamp":timestamp,"action":verb.trim_start_matches('!')});
    match verb {
        "!projects" | "!status" | "!decisions" if args.is_empty() => {}
        "!goal" => {
            let (project, description) = args.split_once(' ')?;
            if description.trim().is_empty() {
                return None;
            }
            command["projectId"] = json!(project);
            command["description"] = json!(description.trim());
        }
        "!pause" | "!resume" | "!cancel" if !args.is_empty() => command["goalId"] = json!(args),
        "!answer" => {
            let parts: Vec<_> = args.split_whitespace().collect();
            if parts.len() != 3 {
                return None;
            }
            command["questionId"] = json!(parts[0]);
            command["revision"] = json!(parts[1].parse::<u64>().ok()?);
            command["option"] = json!(parts[2]);
        }
        "!context" => {
            let (goal, context) = args.split_once(' ')?;
            command["action"] = json!("context");
            command["goalId"] = json!(goal);
            command["context"] = json!(context);
        }
        "!confirm" => {
            let (event, action) = args.split_once(' ')?;
            if !["goal", "pause", "resume", "cancel", "context"].contains(&action) {
                return None;
            }
            command["action"] = json!(action);
            command["confirmationEventId"] = json!(event);
        }
        _ => return None,
    }
    Some(command)
}
pub(crate) async fn trusted_room(client: &Client, config: &ConnectorConfig) -> Result<Room> {
    let room = client
        .get_room(&config.room_id)
        .ok_or("Configured room is unavailable; joining is never automatic")?;
    if !room.latest_encryption_state().await?.is_encrypted() {
        return Err("Configured room must already be encrypted".into());
    }
    if !matches!(
        room.join_rule(),
        Some(matrix_sdk::ruma::events::room::join_rules::JoinRule::Invite)
    ) {
        return Err("Room must be invitation-only".into());
    }
    let own = client
        .encryption()
        .get_own_device()
        .await?
        .ok_or("Own device missing")?;
    if !own.is_verified_with_cross_signing() {
        return Err("Connector device requires explicit cross-signing verification".into());
    }
    let members = room
        .members(RoomMemberships::JOIN | RoomMemberships::INVITE)
        .await?;
    let own_user = client.user_id().ok_or("Session missing")?;
    for member in members {
        if member.user_id() != own_user
            && !config.allowed_users.contains(&member.user_id().to_owned())
        {
            return Err("Unexpected member or invitation; sensitive traffic paused".into());
        }
    }
    Ok(room)
}
pub async fn run(config: ConnectorConfig) -> Result<()> {
    let controller = matrix_sdk::reqwest::Url::parse(&config.controller_url)?;
    if controller.scheme() != "http"
        || controller.host_str() != Some("127.0.0.1")
        || !controller.username().is_empty()
        || controller.password().is_some()
    {
        return Err("Controller URL must be credential-free loopback HTTP".into());
    }
    let homeserver = matrix_sdk::reqwest::Url::parse(&config.homeserver)?;
    if homeserver.scheme() != "https"
        || !homeserver.username().is_empty()
        || homeserver.password().is_some()
    {
        return Err("Homeserver requires credential-free HTTPS".into());
    }
    let _owner = super::StoreOwner::acquire(&config.state_dir)?;
    let session: matrix_sdk::authentication::matrix::MatrixSession =
        serde_json::from_str(&private_text(&config.session_file)?)?;
    if session.meta.user_id != config.own_user || session.meta.device_id != config.own_device {
        return Err("Session differs from configured permanent account/device identity".into());
    }
    let identity_path = config.state_dir.join("identity.json");
    let identity = json!({"homeserver":homeserver.as_str(),"user":config.own_user,"device":config.own_device,"room":config.room_id});
    if identity_path.exists() {
        let recorded: Value = serde_json::from_str(&private_text(&identity_path)?)?;
        if recorded != identity {
            return Err("Permanent Matrix identity changed; use a new state directory".into());
        }
    } else {
        atomic_private(&identity_path, &serde_json::to_vec(&identity)?)?;
    }
    let http = matrix_sdk::reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(matrix_sdk::reqwest::redirect::Policy::none())
        .build()?;
    let controller_token = private_text(&config.controller_token_file)?;
    let inbox_path = config.state_dir.join("inbox.json");
    let mut inbox: Inbox = if inbox_path.exists() {
        serde_json::from_str(&private_text(&inbox_path)?)?
    } else {
        Inbox::default()
    };
    report_health(
        &http,
        &config,
        &controller_token,
        health_report("starting", None, None, &inbox),
    )
    .await;
    let (client, session_fault) = match crate::setup::session_client(&config).await {
        Ok(client) => client,
        Err(error) => {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("auth"), None, &inbox),
            )
            .await;
            return Err(error);
        }
    };
    let mut last_sync = None;
    loop {
        if inbox.recovery.is_some() {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("replay"), last_sync, &inbox),
            )
            .await;
            let room = client
                .get_room(&config.room_id)
                .ok_or("History recovery room unavailable")?;
            let mut completed = false;
            for _ in 0..20 {
                let recovery = inbox.recovery.clone().ok_or("Recovery cursor missing")?;
                let mut options =
                    matrix_sdk::room::MessagesOptions::backward().from(recovery.from.as_str());
                options.limit = 100u32.into();
                let page = room.messages(options).await?;
                let mut next = inbox.clone();
                next.accept_history_page(
                    &inbox_path,
                    page.chunk,
                    page.end,
                    &config.allowed_users,
                    &config.own_user,
                )?;
                inbox = next;
                if inbox.recovery.is_none() {
                    completed = true;
                    break;
                }
            }
            if !completed {
                return Err(
                    "History recovery checkpoint retained; restart to continue bounded recovery"
                        .into(),
                );
            }
        }
        if session_fault.load(std::sync::atomic::Ordering::SeqCst) {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("auth"), last_sync, &inbox),
            )
            .await;
            return Err("Refreshed session could not be persisted".into());
        }
        let settings = SyncSettings::default()
            .timeout(Duration::from_secs(20))
            .token(match &inbox.cursor {
                Some(t) => SyncToken::Specific(t.clone()),
                None => SyncToken::NoToken,
            });
        let sync = match client.sync_once(settings).await {
            Ok(s) => s,
            Err(error) => {
                if matches!(
                    error.client_api_error_kind(),
                    Some(matrix_sdk::ruma::api::error::ErrorKind::UnknownToken(_))
                ) {
                    report_health(
                        &http,
                        &config,
                        &controller_token,
                        health_report("degraded", Some("auth"), last_sync, &inbox),
                    )
                    .await;
                    return Err("Native Matrix login expired; reauthentication required".into());
                }
                report_health(
                    &http,
                    &config,
                    &controller_token,
                    health_report("degraded", Some("transport"), last_sync, &inbox),
                )
                .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        if session_fault.load(std::sync::atomic::Ordering::SeqCst) {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("auth"), last_sync, &inbox),
            )
            .await;
            return Err("Refreshed session could not be persisted".into());
        }
        // SDK progress cannot acknowledge application intake. Explicitly replay
        // from our earlier cursor after a crash before this durable write.
        let update = sync.rooms.joined.get(&config.room_id);
        let events = update.map(|u| u.timeline.events.as_slice()).unwrap_or(&[]);
        if update.is_some_and(|u| u.timeline.limited) {
            let from = update
                .and_then(|u| u.timeline.prev_batch.clone())
                .ok_or("Limited timeline lacks history cursor")?;
            let anchors = inbox.recent_event_ids.clone();
            let mut next = inbox.clone();
            next.recovery = Some(HistoryRecovery {
                next_cursor: sync.next_batch,
                from,
                anchors,
                pages: 0,
            });
            next.stage_optional(
                &inbox_path,
                inbox.cursor.clone(),
                events,
                &config.allowed_users,
                &config.own_user,
            )?;
            inbox = next;
            continue;
        }
        inbox.stage(
            &inbox_path,
            sync.next_batch,
            events,
            false,
            &config.allowed_users,
            &config.own_user,
        )?;
        last_sync = Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64);
        if inbox.trust_fault {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("trust"), last_sync, &inbox),
            )
            .await;
            return Err("Unexpected membership was observed in a sync batch; explicit trust recovery required".into());
        }
        let room = match trusted_room(&client, &config).await {
            Ok(r) => r,
            Err(_) => {
                report_health(
                    &http,
                    &config,
                    &controller_token,
                    health_report("degraded", Some("trust"), last_sync, &inbox),
                )
                .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let mut controller_failed = false;
        let mut delivery_failed = false;
        for entry in &mut inbox.entries {
            if entry.complete || entry.attempts >= 10 {
                continue;
            }
            if entry.event.encryption_info().is_none() {
                let raw: Value = serde_json::from_str(entry.event.raw().json().get())?;
                if raw["type"] == "m.room.encrypted" {
                    let event = serde_json::from_str(entry.event.raw().json().get())?;
                    match room.decrypt_event(&event, None).await {
                        Ok(decrypted) => {
                            entry.event = decrypted;
                            entry.attempts = 0;
                        }
                        Err(_) => {
                            entry.attempts += 1;
                            continue;
                        }
                    }
                } else {
                    entry.complete = true;
                    continue;
                }
            }
            let Some(info) = entry.event.encryption_info() else {
                continue;
            };
            if !matches!(info.verification_state, VerificationState::Verified)
                || !config.allowed_users.contains(&info.sender)
                || Some(info.sender.as_ref()) == client.user_id()
            {
                entry.complete = true;
                continue;
            }
            let Some(device_id) = &info.sender_device else {
                entry.complete = true;
                continue;
            };
            let device = client
                .encryption()
                .get_device(&info.sender, device_id)
                .await?;
            if !device.is_some_and(|d| d.is_verified_with_cross_signing()) {
                continue;
            }
            let event: Value = serde_json::from_str(entry.event.raw().json().get())?;
            if event["type"] != "m.room.message"
                || event["content"]["msgtype"] != "m.text"
                || event["content"].get("m.relates_to").is_some()
            {
                entry.complete = true;
                continue;
            }
            let Some(body) = event["content"]["body"].as_str() else {
                entry.complete = true;
                continue;
            };
            let Some(event_id) = event["event_id"].as_str() else {
                entry.complete = true;
                continue;
            };
            let Some(timestamp) = event["origin_server_ts"].as_u64() else {
                entry.complete = true;
                continue;
            };
            let Some(command) = parse_command(body, event_id, timestamp) else {
                entry.complete = true;
                continue;
            };
            let request = json!({"principal":{"externalIdentity":info.sender,"destination":config.room_id,"trust":{"encrypted":true,"verifiedDevice":true,"allowedMembership":true,"deviceId":device_id}},"command":command});
            let response = http
                .post(format!(
                    "{}/api/v1/human/commands",
                    config.controller_url.trim_end_matches('/')
                ))
                .bearer_auth(&controller_token)
                .json(&request)
                .send()
                .await;
            match response {
                Ok(r) if r.status().is_success() => entry.complete = true,
                Ok(r) if [400, 403, 409, 422].contains(&r.status().as_u16()) => {
                    entry.complete = true
                }
                _ => {
                    controller_failed = true;
                }
            }
        }
        atomic_private(&inbox_path, &serde_json::to_vec(&inbox)?)?;
        if session_fault.load(std::sync::atomic::Ordering::SeqCst) {
            report_health(
                &http,
                &config,
                &controller_token,
                health_report("degraded", Some("auth"), last_sync, &inbox),
            )
            .await;
            return Err("Session durability lost".into());
        }
        let deliveries = http
            .get(format!(
                "{}/api/v1/connector-deliveries",
                config.controller_url.trim_end_matches('/')
            ))
            .bearer_auth(&controller_token)
            .send()
            .await;
        if let Ok(response) = deliveries {
            if response.status().is_success() {
                for delivery in response.json::<Vec<Value>>().await? {
                    if delivery["destination"] != config.room_id.as_str() {
                        return Err(
                            "Delivery destination differs from configured encrypted room".into(),
                        );
                    }
                    let room = match trusted_room(&client, &config).await {
                        Ok(room) => room,
                        Err(error) => {
                            report_health(
                                &http,
                                &config,
                                &controller_token,
                                health_report("degraded", Some("trust"), last_sync, &inbox),
                            )
                            .await;
                            return Err(error);
                        }
                    };
                    let text = delivery_text(&delivery)?;
                    if text.len() > 64000 {
                        return Err("Delivery exceeds encrypted message limit; payload needs bounded summary".into());
                    }
                    let txn: OwnedTransactionId = delivery["transactionId"]
                        .as_str()
                        .ok_or("Delivery transaction missing")?
                        .into();
                    let result = room
                        .send(RoomMessageEventContent::text_plain(text))
                        .with_transaction_id(txn)
                        .await;
                    if session_fault.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err("Session refresh could not be durably saved".into());
                    }
                    let outcome = match result {
                        Ok(result) if result.encryption_info.is_some() => {
                            json!({"status":"sent","receipt":result.response.event_id})
                        }
                        _ => {
                            delivery_failed = true;
                            json!({"status":"retry"})
                        }
                    };
                    let receipt = http
                        .post(format!(
                            "{}/api/v1/connector-deliveries/{}",
                            config.controller_url.trim_end_matches('/'),
                            delivery["id"].as_str().ok_or("Delivery ID missing")?
                        ))
                        .bearer_auth(&controller_token)
                        .json(&outcome)
                        .send()
                        .await;
                    if !receipt.is_ok_and(|response| response.status().is_success()) {
                        controller_failed = true;
                    }
                }
            } else {
                controller_failed = true;
            }
        } else {
            controller_failed = true;
        }
        inbox.entries.retain(|e| !e.complete);
        atomic_private(&inbox_path, &serde_json::to_vec(&inbox)?)?;
        let exhausted = inbox.entries.iter().any(|e| e.attempts >= 10);
        let fault = if controller_failed {
            Some("controller")
        } else if delivery_failed {
            Some("delivery")
        } else if exhausted {
            Some("undecryptable")
        } else {
            None
        };
        report_health(
            &http,
            &config,
            &controller_token,
            health_report(
                if fault.is_some() {
                    "degraded"
                } else {
                    "healthy"
                },
                fault,
                last_sync,
                &inbox,
            ),
        )
        .await;
    }
}
impl Inbox {
    fn accept_history_page(
        &mut self,
        path: &Path,
        events: Vec<TimelineEvent>,
        end: Option<String>,
        allowed: &[OwnedUserId],
        own: &OwnedUserId,
    ) -> Result<()> {
        let recovery = self.recovery.clone().ok_or("No pending history recovery")?;
        let reached = events.iter().any(|e| {
            e.raw()
                .get_field::<String>("event_id")
                .ok()
                .flatten()
                .is_some_and(|id| recovery.anchors.contains(&id))
        });
        let exhausted = end.is_none();
        let mut next = self.clone();
        let cursor = if reached || exhausted {
            next.recovery = None;
            Some(recovery.next_cursor)
        } else {
            let from = end.ok_or("Missing pagination cursor")?;
            if from == recovery.from {
                return Err("History pagination did not advance".into());
            }
            next.recovery = Some(HistoryRecovery {
                from,
                pages: recovery.pages + 1,
                ..recovery
            });
            self.cursor.clone()
        };
        next.stage_optional(path, cursor, &events, allowed, own)?;
        *self = next;
        Ok(())
    }
}

fn delivery_text(delivery: &Value) -> Result<String> {
    let payload = &delivery["payload"];
    if delivery["kind"] == "question" {
        let id = payload["questionId"]
            .as_str()
            .ok_or("Question ID missing")?;
        let revision = payload["revision"]
            .as_u64()
            .ok_or("Question revision missing")?;
        let request = &payload["request"];
        let mut text = format!(
            "Decision {} · revision {}\nGoal: {}\n{}\n{}\n",
            id,
            revision,
            payload["scope"]["goalId"].as_str().unwrap_or("Instance"),
            request["question"]
                .as_str()
                .ok_or("Question text missing")?,
            request["reason"].as_str().unwrap_or("")
        );
        for (index, option) in request["options"]
            .as_array()
            .ok_or("Decision options missing")?
            .iter()
            .enumerate()
        {
            text.push_str(&format!(
                "{}. {}\n!answer {} {} {}\n",
                index + 1,
                option["label"].as_str().ok_or("Option label missing")?,
                id,
                revision,
                option["id"].as_str().ok_or("Option ID missing")?
            ));
        }
        return Ok(text);
    }
    if delivery["kind"] == "completed" {
        return Ok(format!(
            "Goal {} completed.\nResult and evidence saved. Send !status to inspect recorded status.",
            payload["goalId"].as_str().ok_or("Goal ID missing")?
        ));
    }
    if delivery["kind"] == "command_receipt" {
        let result = &payload["result"];
        let mut text = "Durably accepted by MissionControl.\n".to_owned();
        if let Some(items) = result.as_array() {
            if items.is_empty() {
                text.push_str("No matching projects or goals.");
            }
            for item in items.iter().take(50) {
                if let (Some(id), Some(name), Some(enabled)) = (
                    item["id"].as_str(),
                    item["name"].as_str(),
                    item["enabled"].as_bool(),
                ) {
                    text.push_str(&format!(
                        "{} · {} ({})\n",
                        name,
                        id,
                        if enabled { "enabled" } else { "disabled" }
                    ));
                } else if let (Some(id), Some(status)) =
                    (item["id"].as_str(), item["status"].as_str())
                {
                    text.push_str(&format!("{} · {}\n", id, status));
                    if let Some(title) = item["title"].as_str() {
                        text.push_str(&format!(
                            "{}\n",
                            title.chars().take(500).collect::<String>()
                        ));
                    }
                    if let Some(tasks) = item["tasks"].as_array() {
                        let accepted = tasks
                            .iter()
                            .filter(|task| task["status"] == "accepted")
                            .count();
                        text.push_str(&format!("Tasks accepted: {}/{}\n", accepted, tasks.len()));
                    }
                    if let (Some(settled), Some(reserved), Some(unresolved)) = (
                        item["budget"]["settledUsd"].as_f64(),
                        item["budget"]["reservedUsd"].as_f64(),
                        item["budget"]["unresolvedUsd"].as_f64(),
                    ) {
                        text.push_str(&format!("Accounting: ${:.2} settled · ${:.2} reserved · ${:.2} unresolved.\nSettled values may include estimates.\n", settled, reserved, unresolved));
                    }
                }
            }
        } else if let (Some(id), Some(status)) =
            (result["goalId"].as_str(), result["status"].as_str())
        {
            text.push_str(&format!("Goal {} · {}", id, status));
        } else if result["status"] == "answered" {
            text.push_str("Decision answer recorded.");
        } else if result["contextSaved"] == true {
            text.push_str("Goal context saved.");
        } else if result["confirmationRequired"] == true {
            text.push_str(
                "This older command needs a fresh explicit confirmation before it can change work.",
            );
        } else {
            text.push_str("Command recorded. Send !status or !decisions for details.");
        }
        return Ok(text);
    }
    // Unknown internal payloads may contain filesystem paths, session details,
    // model content or report metadata. Never dump them into a human transport.
    Ok("MissionControl update. Send !status or !decisions for recorded details.".to_owned())
}
pub(crate) fn clear_reviewed_trust_fault(config: &ConnectorConfig) -> Result<()> {
    let path = config.state_dir.join("inbox.json");
    let mut inbox: Inbox = serde_json::from_str(&private_text(&path)?)?;
    // Preserve all events and cursor. Remediation never acknowledges commands.
    inbox.trust_fault = false;
    atomic_private(&path, &serde_json::to_vec(&inbox)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn human_receipts_omit_internal_payloads_and_preserve_recorded_status() {
        let internal = "/private/state/goals/report.json";
        let completed = delivery_text(&json!({"kind":"completed","payload":{"goalId":"goal_synthetic","result":{"report":internal}}})).unwrap();
        assert!(completed.contains("completed"));
        assert!(!completed.contains(internal));
        let status = delivery_text(&json!({"kind":"command_receipt","payload":{"eventId":"private-event","result":[{"id":"goal_synthetic","title":"Synthetic task","status":"completed","result":{"report":internal},"tasks":[{"status":"accepted"}],"budget":{"settledUsd":0,"reservedUsd":0,"unresolvedUsd":0}}]}})).unwrap();
        assert!(status.contains("Tasks accepted: 1/1"));
        assert!(!status.contains(internal));
        assert!(!status.contains("private-event"));
        let projects = delivery_text(&json!({"kind":"command_receipt","payload":{"result":[{"id":"synthetic","name":"Synthetic installation","enabled":true}]}})).unwrap();
        assert!(projects.contains("Synthetic installation · synthetic (enabled)"));
        let unknown =
            delivery_text(&json!({"kind":"unknown","payload":{"secret":internal}})).unwrap();
        assert!(!unknown.contains(internal));
    }
    fn event(id: &str, content: Value) -> TimelineEvent {
        let raw = serde_json::json!({"type":"m.room.message","event_id":id,"sender":"@operator:example.invalid","origin_server_ts":1,"content":content});
        TimelineEvent::from_plaintext(matrix_sdk::ruma::serde::Raw::from_json(
            serde_json::value::to_raw_value(&raw).unwrap(),
        ))
    }
    #[test]
    fn completed_events_are_not_reintroduced_during_history_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("inbox.json");
        let own: OwnedUserId = "@bot:example.invalid".try_into().unwrap();
        let message = event("$completed", json!({"msgtype":"m.text","body":"!status"}));
        let mut inbox = Inbox::default();
        inbox
            .stage(&path, "one".into(), &[message.clone()], false, &[], &own)
            .unwrap();
        inbox.entries.clear();
        inbox
            .stage(&path, "two".into(), &[message], false, &[], &own)
            .unwrap();
        assert!(inbox.entries.is_empty());
        assert_eq!(inbox.cursor.as_deref(), Some("two"));
    }
    #[test]
    fn encrypted_question_text_carries_revision_scope_and_explicit_options() {
        let delivery = json!({"kind":"question","payload":{"questionId":"q-one","revision":2,"scope":{"goalId":"g-one"},"request":{"question":"Choose?","reason":"Synthetic","options":[{"id":"inspect","label":"Inspect"},{"id":"defer","label":"Defer"}]}}});
        let text = delivery_text(&delivery).unwrap();
        assert!(text.contains("revision 2"));
        assert!(text.contains("!answer q-one 2 inspect"));
        assert!(text.contains("1. Inspect"));
        assert!(text.contains("g-one"));
    }
    #[test]
    fn history_recovery_keeps_cursor_until_overlap_and_persists_each_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("inbox.json");
        let own: OwnedUserId = "@bot:example.invalid".try_into().unwrap();
        let mut inbox = Inbox::default();
        inbox
            .stage(
                &path,
                "old".into(),
                &[event(
                    "$anchor",
                    json!({"msgtype":"m.text","body":"!status"}),
                )],
                false,
                &[],
                &own,
            )
            .unwrap();
        inbox.recovery = Some(HistoryRecovery {
            next_cursor: "next-sync".into(),
            from: "page-1".into(),
            anchors: vec!["$anchor".into()],
            pages: 0,
        });
        inbox
            .accept_history_page(
                &path,
                vec![event("$new", json!({"msgtype":"m.text","body":"!status"}))],
                Some("page-2".into()),
                &[],
                &own,
            )
            .unwrap();
        assert_eq!(inbox.cursor.as_deref(), Some("old"));
        let mut reopened: Inbox = serde_json::from_str(&private_text(&path).unwrap()).unwrap();
        assert_eq!(reopened.recovery.as_ref().unwrap().from, "page-2");
        assert!(
            reopened
                .accept_history_page(
                    &path,
                    vec![event("$other", json!({}))],
                    Some("page-2".into()),
                    &[],
                    &own
                )
                .is_err()
        );
        reopened
            .accept_history_page(
                &path,
                vec![event("$anchor", json!({}))],
                Some("page-3".into()),
                &[],
                &own,
            )
            .unwrap();
        assert_eq!(reopened.cursor.as_deref(), Some("next-sync"));
        assert!(reopened.recovery.is_none());
        assert_eq!(reopened.entries.len(), 2);
    }
    #[test]
    fn sdk_events_are_durable_before_cursor_advances_and_duplicate_replay_is_safe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("inbox.json");
        let mut inbox = Inbox::default();
        let own: OwnedUserId = "@bot:example.invalid".try_into().unwrap();
        let batch = vec![event("$one", json!({"msgtype":"m.text","body":"!status"}))];
        inbox
            .stage(&path, "cursor-1".into(), &batch, false, &[], &own)
            .unwrap();
        let mut restored: Inbox = serde_json::from_str(&private_text(&path).unwrap()).unwrap();
        restored
            .stage(&path, "cursor-2".into(), &batch, false, &[], &own)
            .unwrap();
        assert_eq!(restored.entries.len(), 1);
        assert_eq!(restored.cursor.as_deref(), Some("cursor-2"));
        assert!(
            restored
                .stage(&path, "lost".into(), &[], true, &[], &own)
                .is_err()
        );
        assert_eq!(restored.cursor.as_deref(), Some("cursor-2"));
        let failed = directory.path().join("missing/inbox.json");
        assert!(
            restored
                .stage(&failed, "unwritten".into(), &[], false, &[], &own)
                .is_err()
        );
        assert_eq!(restored.cursor.as_deref(), Some("cursor-2"));
    }
    #[test]
    fn unexpected_membership_in_batch_persists_a_trust_fault() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("inbox.json");
        let mut inbox = Inbox::default();
        let own: OwnedUserId = "@bot:example.invalid".try_into().unwrap();
        let raw = json!({"type":"m.room.member","event_id":"$join","sender":"@stranger:example.invalid","state_key":"@stranger:example.invalid","origin_server_ts":1,"content":{"membership":"join"}});
        let member = TimelineEvent::from_plaintext(matrix_sdk::ruma::serde::Raw::from_json(
            serde_json::value::to_raw_value(&raw).unwrap(),
        ));
        inbox
            .stage(&path, "cursor".into(), &[member], false, &[], &own)
            .unwrap();
        let reopened: Inbox = serde_json::from_str(&private_text(&path).unwrap()).unwrap();
        assert!(reopened.trust_fault);
    }
    #[test]
    fn explicit_commands_only() {
        assert!(parse_command("ordinary chat", "$test", 1).is_none());
        assert!(parse_command("!goal sample Work", "$test", 1).is_some());
        assert!(parse_command("!answer q 2 a", "$test", 1).is_some());
        assert!(parse_command("!answer q wrong a", "$test", 1).is_none());
    }
    #[test]
    fn health_reports_include_only_counts_and_fault_codes() {
        let mut inbox = Inbox::default();
        inbox.entries.push(InboxEntry {
            event: event(
                "$private-event",
                json!({"body":"private command", "access_token":"sensitive"}),
            ),
            attempts: 10,
            complete: false,
        });
        let report = health_report("degraded", Some("undecryptable"), Some(123), &inbox);
        assert_eq!(report["pendingInbox"], 1);
        assert_eq!(report["exhaustedInbox"], 1);
        assert_eq!(report["lastSyncAt"], 123);
        assert!(!report.to_string().contains("private"));
        assert!(!report.to_string().contains("sensitive"));
    }
}
