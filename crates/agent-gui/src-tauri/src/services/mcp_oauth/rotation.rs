//! Native-owned, bounded recovery of an AS rotation whose durable save failed.
use super::{
    store::{SaveRetry, TokenRecord, TokenStore},
    CredentialOwner, AUTH_REQUIRED_MARKER,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};

const SAVE_PENDING: &str = "MCP_OAUTH_CREDENTIAL_SAVE_PENDING";
const CAPACITY: &str = "MCP_OAUTH_ROTATION_RECOVERY_LIMIT";
const MAX_ENTRIES: usize = 16;
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    revision: u64,
    digest: String,
}
struct Pending {
    record: TokenRecord,
    retry: SaveRetry,
}
struct Slot {
    stamp: Stamp,
    ticket: u64,
    bytes: usize,
    pending: Option<Pending>,
}
struct State {
    active: bool,
    ticket: u64,
    slots: HashMap<String, Slot>,
}

pub(super) struct RotationRecovery {
    state: Mutex<State>,
    max_entries: usize,
    max_bytes: usize,
}

impl RotationRecovery {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(State {
                active: true,
                ticket: 0,
                slots: HashMap::new(),
            }),
            max_entries: MAX_ENTRIES,
            max_bytes: MAX_BYTES,
        }
    }

    pub(super) fn revoke(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.active = false;
        state.slots.clear();
    }

    #[cfg(test)]
    pub(super) fn retained_count(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .slots
            .values()
            .filter(|slot| slot.pending.is_some())
            .count()
    }

    fn discard(&self, identity: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.slots.remove(identity);
        }
    }

    fn pending<'a>(
        &'a self,
        identity: &str,
        stamp: &Stamp,
    ) -> Result<Option<(Attempt<'a>, Pending)>, String> {
        let mut state = self.state.lock().map_err(|_| AUTH_REQUIRED_MARKER)?;
        if !state.active {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        // All slots belong to this broker/profile. A Native MCP mutation cancels
        // old operations, including an edit back to the same target material.
        let superseded = state
            .slots
            .get(identity)
            .is_some_and(|slot| slot.stamp != *stamp);
        state.slots.retain(|id, slot| {
            slot.stamp.revision == stamp.revision && (id != identity || slot.stamp == *stamp)
        });
        if superseded {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        let Some(slot) = state.slots.get_mut(identity) else {
            return Ok(None);
        };
        let pending = slot.pending.take().ok_or(AUTH_REQUIRED_MARKER)?;
        Ok(Some((
            Attempt {
                owner: self,
                identity: identity.into(),
                ticket: slot.ticket,
                retained: false,
            },
            pending,
        )))
    }

    fn reserve<'a>(
        &'a self,
        identity: &str,
        stamp: Stamp,
        record: &TokenRecord,
    ) -> Result<Attempt<'a>, String> {
        // The response parser limits the complete AS JSON body to 1 MiB. Reserve
        // that growth (with another full body and fixed-field margin) *before*
        // consuming the grant, rather than evicting a failed earlier rotation.
        let bytes = record_bytes(record)?
            .checked_add(super::MAX_OAUTH_RESPONSE_BYTES * 2 + 1024)
            .ok_or(CAPACITY)?;
        let mut state = self.state.lock().map_err(|_| AUTH_REQUIRED_MARKER)?;
        if !state.active {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        let used: usize = state.slots.values().map(|slot| slot.bytes).sum();
        if state.slots.contains_key(identity)
            || state.slots.len() >= self.max_entries
            || bytes > self.max_bytes.saturating_sub(used)
        {
            return Err(CAPACITY.into());
        }
        state.ticket = state.ticket.checked_add(1).ok_or(CAPACITY)?;
        let ticket = state.ticket;
        state.slots.insert(
            identity.into(),
            Slot {
                stamp,
                ticket,
                bytes,
                pending: None,
            },
        );
        Ok(Attempt {
            owner: self,
            identity: identity.into(),
            ticket,
            retained: false,
        })
    }

    pub(super) fn credential(
        &self,
        store: &TokenStore,
        url: &str,
        digest: &str,
        revision: u64,
        previous_hash: &str,
        owner: &dyn CredentialOwner,
    ) -> Result<TokenRecord, String> {
        // Share the existing refresh lock with legacy callers. No ledger or
        // profile lock is held while waiting on the AS or another request.
        let lock = super::refresh_lock_for(store.identity());
        let _guard = lock.lock().map_err(|_| AUTH_REQUIRED_MARKER)?;
        if let Err(error) = owner.validate() {
            self.discard(store.identity());
            return Err(error);
        }
        let stamp = Stamp {
            revision,
            digest: digest.into(),
        };
        if let Some((attempt, pending)) = self.pending(store.identity(), &stamp)? {
            // Retry even if a partially successful keyring write already made
            // the fresh token readable. Cleanup/ACK must finish before release.
            owner.validate()?;
            attempt.validate()?;
            return match store.retry_refresh(&pending.record, &pending.retry) {
                Ok(_) => {
                    owner.validate()?;
                    Ok(pending.record)
                }
                Err(failure) => {
                    if let Some(retry) = failure.retry {
                        owner.validate()?;
                        attempt.retain(pending.record, retry)?;
                        Err(SAVE_PENDING.into())
                    } else {
                        Err(failure.message)
                    }
                }
            };
        }
        let baseline = store.snapshot()?;
        let current = baseline
            .record
            .as_ref()
            .filter(|record| {
                record.server_url == url && record.target_binding.as_deref() == Some(digest)
            })
            .ok_or(AUTH_REQUIRED_MARKER)?;
        let hash = Sha256::digest(current.access_token.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let force = !previous_hash.is_empty() && previous_hash == hash;
        if !force && !current.is_expiring(super::store::now_ms()) {
            return Ok(current.clone());
        }
        if current.refresh_token.is_none() {
            return if force || current.is_expired(super::store::now_ms()) {
                Err(AUTH_REQUIRED_MARKER.into())
            } else {
                Ok(current.clone())
            };
        }
        let attempt = self.reserve(store.identity(), stamp, current)?;
        let next = super::request_refreshed_record(current)?;
        owner.validate()?;
        attempt.validate()?;
        match store.save_refresh(&next, &baseline) {
            Ok(_) => {
                owner.validate()?;
                Ok(next)
            }
            Err(failure) => {
                if let Some(retry) = failure.retry {
                    owner.validate()?;
                    attempt.retain(next, retry)?;
                    Err(SAVE_PENDING.into())
                } else {
                    Err(failure.message)
                }
            }
        }
    }
}

fn record_bytes(record: &TokenRecord) -> Result<usize, String> {
    serde_json::to_vec(record)
        .map(|bytes| bytes.len())
        .map_err(|_| CAPACITY.into())
}

struct Attempt<'a> {
    owner: &'a RotationRecovery,
    identity: String,
    ticket: u64,
    retained: bool,
}
impl Attempt<'_> {
    fn validate(&self) -> Result<(), String> {
        let state = self.owner.state.lock().map_err(|_| AUTH_REQUIRED_MARKER)?;
        if !state.active
            || !state
                .slots
                .get(&self.identity)
                .is_some_and(|slot| slot.ticket == self.ticket)
        {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        Ok(())
    }
    fn retain(mut self, record: TokenRecord, retry: SaveRetry) -> Result<(), String> {
        let bytes = record_bytes(&record)?;
        // A profile write can block on OS storage. Never make host revocation
        // wait for it while holding the recovery table lock. CAS is repeated on
        // every retry, so a later superseding write still rejects this proof.
        if !retry.is_current() {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        let mut state = self.owner.state.lock().map_err(|_| AUTH_REQUIRED_MARKER)?;
        if !state.active {
            return Err(AUTH_REQUIRED_MARKER.into());
        }
        let slot = state
            .slots
            .get_mut(&self.identity)
            .filter(|slot| slot.ticket == self.ticket)
            .ok_or(AUTH_REQUIRED_MARKER)?;
        if bytes > slot.bytes {
            return Err(CAPACITY.into());
        }
        slot.bytes = bytes;
        slot.pending = Some(Pending { record, retry });
        self.retained = true;
        Ok(())
    }
}
impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        if let Ok(mut state) = self.owner.state.lock() {
            if state
                .slots
                .get(&self.identity)
                .is_some_and(|slot| slot.ticket == self.ticket)
            {
                state.slots.remove(&self.identity);
            }
        }
    }
}

#[cfg(test)]
mod tests;
