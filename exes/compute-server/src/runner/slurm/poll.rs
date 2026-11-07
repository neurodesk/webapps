//! One `squeue --me` per interval for all active jobs, shared through a
//! watch channel. Failing polls leave job states unchanged; failures for
//! longer than the configured window make the runner unavailable.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use super::commands::{QueueEntry, Slurm};

/// The latest queue, `None` after a failed poll.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// Increases with every poll.
    pub generation: u64,
    /// The user's queued jobs by id.
    pub queue: Option<Arc<HashMap<String, QueueEntry>>>,
}

struct Shared {
    slurm: Slurm,
    interval: Duration,
    unavailable_after: Duration,
    tx: watch::Sender<Snapshot>,
    started: AtomicBool,
    failing_since: Mutex<Option<Instant>>,
}

/// The shared poller.
#[derive(Clone)]
pub struct Poller {
    shared: Arc<Shared>,
}

impl Poller {
    /// A poller that starts with its first subscriber.
    pub fn new(slurm: Slurm, interval: Duration, unavailable_after: Duration) -> Poller {
        Poller {
            shared: Arc::new(Shared {
                slurm,
                interval,
                unavailable_after,
                tx: watch::Sender::new(Snapshot::default()),
                started: AtomicBool::new(false),
                failing_since: Mutex::new(None),
            }),
        }
    }

    /// Receives every snapshot; the first call starts polling.
    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        let receiver = self.shared.tx.subscribe();
        if !self.shared.started.swap(true, Ordering::SeqCst) {
            tokio::spawn(poll(Arc::downgrade(&self.shared)));
        }
        receiver
    }

    /// An error while polling has failed for longer than the window.
    pub fn health(&self) -> Result<(), String> {
        let failing = *lock(&self.shared.failing_since);
        match failing {
            Some(since) if since.elapsed() >= self.shared.unavailable_after => Err(format!(
                "squeue has failed for {}s; Slurm is unavailable",
                since.elapsed().as_secs()
            )),
            _ => Ok(()),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

async fn poll(shared: Weak<Shared>) {
    let mut generation = 0;
    loop {
        let Some(current) = shared.upgrade() else {
            return;
        };
        let failing = lock(&current.failing_since).is_some();
        if current.tx.receiver_count() > 0 || failing {
            generation += 1;
            let queue = match current.slurm.queue().await {
                Ok(queue) => {
                    *lock(&current.failing_since) = None;
                    Some(Arc::new(queue))
                }
                Err(error) => {
                    tracing::warn!(%error, "squeue failed; job states are unchanged");
                    lock(&current.failing_since).get_or_insert_with(Instant::now);
                    None
                }
            };
            current.tx.send_replace(Snapshot { generation, queue });
        }
        let interval = current.interval;
        drop(current);
        tokio::time::sleep(interval).await;
    }
}
