use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSessionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RuntimeSession {
    pub session_id: String,
    pub owner_id: String,
    pub provider_id: String,
    pub status: RuntimeSessionStatus,
    pub revision: u64,
    pub started_at: u64,
    pub last_heartbeat_at: u64,
}

#[derive(Default)]
pub struct AgentRuntimeState {
    sessions: RwLock<HashMap<String, RuntimeSession>>,
}

impl AgentRuntimeState {
    pub fn start(
        &self,
        session_id: String,
        owner_id: String,
        provider_id: String,
        now: u64,
    ) -> Result<RuntimeSession, String> {
        let mut sessions = self.sessions.write().map_err(|_| "runtime lock poisoned")?;
        if sessions.contains_key(&session_id) {
            return Err("session already exists".into());
        }
        let session = RuntimeSession {
            session_id: session_id.clone(),
            owner_id,
            provider_id,
            status: RuntimeSessionStatus::Running,
            revision: 0,
            started_at: now,
            last_heartbeat_at: now,
        };
        sessions.insert(session_id, session.clone());
        Ok(session)
    }

    pub fn heartbeat(
        &self,
        session_id: &str,
        owner_id: &str,
        expected_revision: u64,
        now: u64,
    ) -> Result<RuntimeSession, String> {
        let mut sessions = self.sessions.write().map_err(|_| "runtime lock poisoned")?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "session not found".to_string())?;
        if session.owner_id != owner_id {
            return Err("session owner mismatch".into());
        }
        if session.revision != expected_revision {
            return Err(format!(
                "session revision mismatch: expected {}, got {}",
                session.revision, expected_revision
            ));
        }
        if session.status != RuntimeSessionStatus::Running {
            return Err("session is not running".into());
        }
        session.revision += 1;
        session.last_heartbeat_at = now;
        Ok(session.clone())
    }

    pub fn finish(
        &self,
        session_id: &str,
        owner_id: &str,
        expected_revision: u64,
        status: RuntimeSessionStatus,
        now: u64,
    ) -> Result<RuntimeSession, String> {
        if !matches!(
            status,
            RuntimeSessionStatus::Completed
                | RuntimeSessionStatus::Failed
                | RuntimeSessionStatus::Cancelled
        ) {
            return Err("finish requires a terminal status".into());
        }
        let mut sessions = self.sessions.write().map_err(|_| "runtime lock poisoned")?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "session not found".to_string())?;
        if session.owner_id != owner_id {
            return Err("session owner mismatch".into());
        }
        if session.revision != expected_revision {
            return Err(format!(
                "session revision mismatch: expected {}, got {}",
                session.revision, expected_revision
            ));
        }
        if session.status != RuntimeSessionStatus::Running {
            return Err("session is not running".into());
        }
        session.revision += 1;
        session.status = status;
        session.last_heartbeat_at = now;
        Ok(session.clone())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<RuntimeSession, String> {
        self.sessions
            .read()
            .map_err(|_| "runtime lock poisoned")?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "session not found".into())
    }
}

fn now_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "system clock is before Unix epoch".into())
}

#[tauri::command]
pub fn agent_runtime_start(
    state: tauri::State<'_, AgentRuntimeState>,
    session_id: String,
    owner_id: String,
    provider_id: String,
) -> Result<RuntimeSession, String> {
    state.start(session_id, owner_id, provider_id, now_millis()?)
}

#[tauri::command]
pub fn agent_runtime_heartbeat(
    state: tauri::State<'_, AgentRuntimeState>,
    session_id: String,
    owner_id: String,
    revision: u64,
) -> Result<RuntimeSession, String> {
    state.heartbeat(&session_id, &owner_id, revision, now_millis()?)
}

#[tauri::command]
pub fn agent_runtime_finish(
    state: tauri::State<'_, AgentRuntimeState>,
    session_id: String,
    owner_id: String,
    revision: u64,
    status: RuntimeSessionStatus,
) -> Result<RuntimeSession, String> {
    state.finish(&session_id, &owner_id, revision, status, now_millis()?)
}

#[tauri::command]
pub fn agent_runtime_snapshot(
    state: tauri::State<'_, AgentRuntimeState>,
    session_id: String,
) -> Result<RuntimeSession, String> {
    state.snapshot(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_and_advances_a_runtime_session() {
        let state = AgentRuntimeState::default();
        let started = state
            .start("s-1".into(), "owner-1".into(), "mock".into(), 100)
            .unwrap();
        assert_eq!(started.status, RuntimeSessionStatus::Running);

        let beat = state.heartbeat("s-1", "owner-1", 0, 101).unwrap();
        assert_eq!(beat.revision, 1);
        assert_eq!(beat.last_heartbeat_at, 101);
    }

    #[test]
    fn rejects_wrong_owner_stale_revision_and_duplicate_start() {
        let state = AgentRuntimeState::default();
        state
            .start("s-1".into(), "owner-1".into(), "mock".into(), 100)
            .unwrap();

        assert_eq!(
            state.heartbeat("s-1", "owner-2", 0, 101).unwrap_err(),
            "session owner mismatch"
        );
        assert!(state.heartbeat("s-1", "owner-1", 1, 101).is_err());
        assert_eq!(
            state
                .start("s-1".into(), "owner-1".into(), "mock".into(), 102)
                .unwrap_err(),
            "session already exists"
        );
    }

    #[test]
    fn terminal_transition_is_single_use() {
        let state = AgentRuntimeState::default();
        state
            .start("s-1".into(), "owner-1".into(), "mock".into(), 100)
            .unwrap();
        let done = state
            .finish("s-1", "owner-1", 0, RuntimeSessionStatus::Completed, 101)
            .unwrap();
        assert_eq!(done.status, RuntimeSessionStatus::Completed);
        assert!(state.heartbeat("s-1", "owner-1", 1, 102).is_err());
    }
}
