use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Room {
    next_player_id: AtomicU64,
}

impl Room {
    pub fn new() -> Self {
        Self {
            next_player_id: AtomicU64::new(1),
        }
    }

    pub fn allocate_player_id(&self) -> u64 {
        self.next_player_id.fetch_add(1, Ordering::Relaxed)
    }
}
