//! Native ownership of mobile HTTP results, cache entries and WebSocket lifetimes.
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize, Serializer};
use tokio::sync::{oneshot, watch};

const SESSION_COOKIE: &str = "zeroagent_session";
const MAX_CACHE_ENTRIES: usize = 96;
const SESSION_CHANGED: &str = "Gateway account session changed";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayResponse {
    pub status: u16,
    #[serde(serialize_with = "serialize_public_headers")]
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub cached: bool,
}

fn public_header(name: &str) -> bool {
    !name.eq_ignore_ascii_case("set-cookie") && !name.eq_ignore_ascii_case("set-cookie2")
}

fn serialize_public_headers<S: Serializer>(
    headers: &BTreeMap<String, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    headers
        .iter()
        .filter(|(name, _)| public_header(name))
        .collect::<BTreeMap<_, _>>()
        .serialize(serializer)
}

#[derive(Clone)]
pub struct RequestOwner {
    generation: u64,
    pub origin: String,
    pub session_id: String,
    invalidation: watch::Receiver<u64>,
}

impl RequestOwner {
    pub fn is_live(&self) -> bool {
        *self.invalidation.borrow() == self.generation
    }

    async fn invalidated(mut self) {
        while self.is_live() {
            if self.invalidation.changed().await.is_err() {
                break;
            }
        }
    }
}

pub struct MobileGatewaySession {
    pub origin: String,
    pub session_id: String,
    pub user_id: Option<i64>,
    pub cache: BTreeMap<String, MobileGatewayResponse>,
    generation: u64,
    invalidation: watch::Sender<u64>,
}

impl Default for MobileGatewaySession {
    fn default() -> Self {
        let (invalidation, _) = watch::channel(0);
        Self {
            origin: String::new(),
            session_id: String::new(),
            user_id: None,
            cache: BTreeMap::new(),
            generation: 0,
            invalidation,
        }
    }
}

impl MobileGatewaySession {
    fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.invalidation.send_replace(self.generation);
    }

    pub fn owner(&self) -> Result<RequestOwner, String> {
        if self.origin.is_empty() {
            return Err("Configure the Gateway URL before signing in".into());
        }
        Ok(RequestOwner {
            generation: self.generation,
            origin: self.origin.clone(),
            session_id: self.session_id.clone(),
            invalidation: self.invalidation.subscribe(),
        })
    }

    pub fn require_owner(&self, owner: &RequestOwner) -> Result<(), String> {
        if owner.generation != self.generation
            || owner.origin != self.origin
            || owner.session_id != self.session_id
            || !owner.is_live()
        {
            return Err(SESSION_CHANGED.into());
        }
        Ok(())
    }

    pub fn restore(
        &mut self,
        origin: String,
        session_id: String,
        user_id: Option<i64>,
        cache: BTreeMap<String, MobileGatewayResponse>,
    ) {
        self.invalidate();
        self.origin = origin;
        self.session_id = session_id;
        self.user_id = user_id;
        self.cache = cache;
        for response in self.cache.values_mut() {
            response.headers.retain(|name, _| public_header(name));
        }
    }

    pub fn logout(&mut self) {
        self.invalidate();
        self.session_id.clear();
        self.user_id = None;
        self.cache.clear();
    }

    pub fn cached(
        &self,
        owner: &RequestOwner,
        key: &str,
    ) -> Result<Option<MobileGatewayResponse>, String> {
        self.require_owner(owner)?;
        Ok(self.cache.get(key).map(|response| {
            let mut response = response.clone();
            response.headers.retain(|name, _| public_header(name));
            response.cached = true;
            response
        }))
    }

    pub fn accept_response(
        &mut self,
        owner: &RequestOwner,
        path: &str,
        status: u16,
        mut headers: BTreeMap<String, String>,
        cookies: &[String],
        body: String,
        cache_key: Option<&str>,
    ) -> Result<MobileGatewayResponse, String> {
        // This check precedes every cookie, identity, cache and persistence mutation.
        self.require_owner(owner)?;
        let old_cookie = self.session_id.clone();
        let old_user = self.user_id;
        for value in cookies {
            let Some((name, rest)) = value.split_once('=') else {
                continue;
            };
            if name.trim() == SESSION_COOKIE {
                self.session_id = rest.split(';').next().unwrap_or_default().trim().into();
            }
        }
        if !old_cookie.is_empty() && self.session_id.is_empty() {
            self.user_id = None;
        }
        if (200..300).contains(&status) && path.starts_with("/api/auth/") {
            if let Some(id) = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value.get("user")?.get("id")?.as_i64())
            {
                self.user_id = Some(id);
            }
        }
        if self.session_id != old_cookie || self.user_id != old_user {
            self.invalidate();
            self.cache.clear();
        }
        headers.retain(|name, _| public_header(name));
        let result = MobileGatewayResponse {
            status,
            headers,
            body,
            cached: false,
        };
        if (200..300).contains(&status) && self.user_id.is_some() {
            if let Some(key) = cache_key {
                if self.cache.len() >= MAX_CACHE_ENTRIES {
                    self.cache.pop_first();
                }
                self.cache.insert(key.into(), result.clone());
            }
        }
        Ok(result)
    }
}

struct OwnedSocket<T> {
    owner: RequestOwner,
    instance: u64,
    value: T,
}

pub struct SocketRegistry<T> {
    next_instance: u64,
    entries: HashMap<String, OwnedSocket<T>>,
}

impl<T> Default for SocketRegistry<T> {
    fn default() -> Self {
        Self {
            next_instance: 0,
            entries: HashMap::new(),
        }
    }
}

impl<T> SocketRegistry<T> {
    // The caller holds the session lock until registration finishes, including this check.
    pub fn insert(
        &mut self,
        session: &MobileGatewaySession,
        owner: RequestOwner,
        id: String,
        value: T,
    ) -> Result<(u64, Option<T>), String> {
        session.require_owner(&owner)?;
        if owner.session_id.is_empty() {
            return Err("Account login is required".into());
        }
        self.next_instance = self.next_instance.wrapping_add(1);
        let instance = self.next_instance;
        let previous = self.entries.insert(
            id,
            OwnedSocket {
                owner,
                instance,
                value,
            },
        );
        Ok((instance, previous.map(|entry| entry.value)))
    }

    pub fn get(&self, session: &MobileGatewaySession, id: &str) -> Result<&T, String> {
        let entry = self
            .entries
            .get(id)
            .ok_or("Gateway WebSocket is not connected")?;
        session.require_owner(&entry.owner)?;
        Ok(&entry.value)
    }

    pub fn is_current(&self, session: &MobileGatewaySession, id: &str, instance: u64) -> bool {
        self.entries.get(id).is_some_and(|entry| {
            entry.instance == instance && session.require_owner(&entry.owner).is_ok()
        })
    }

    pub fn remove_current(&mut self, id: &str, instance: u64) -> Option<T> {
        if self
            .entries
            .get(id)
            .is_some_and(|entry| entry.instance == instance)
        {
            self.remove(id)
        } else {
            None
        }
    }

    pub fn remove(&mut self, id: &str) -> Option<T> {
        self.entries.remove(id).map(|entry| entry.value)
    }

    pub fn drain(&mut self) -> impl Iterator<Item = T> + '_ {
        self.entries.drain().map(|(_, entry)| entry.value)
    }
}

pub async fn run_owned<T>(
    owner: RequestOwner,
    cancelled: oneshot::Receiver<()>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = owner.invalidated() => None,
        _ = cancelled => None,
        result = work => Some(result),
    }
}

#[cfg(test)]
#[path = "session/tests.rs"]
mod tests;
