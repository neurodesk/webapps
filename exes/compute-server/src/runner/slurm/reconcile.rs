//! Finding a job whose `sbatch` answer was lost: by its unique name, for the
//! server's user, in the queue and in accounting from a margin before the
//! recorded submission time. Empty answers prove absence only after both
//! have stayed empty for the retry window; the server never resubmits.

use std::time::Instant;

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use super::commands::Slurm;
use super::SlurmTimings;

/// What reconciliation established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciled {
    /// Slurm knows the job under this id.
    Found(String),
    /// Queue and accounting stayed empty for the retry window.
    Absent,
    /// The server is stopping; the job stays unresolved.
    Detached,
}

/// Looks the job up until it is found, proven absent, or the server stops.
pub async fn reconcile(
    slurm: &Slurm,
    name: &str,
    submitted_at: DateTime<Utc>,
    timings: &SlurmTimings,
    detach: &CancellationToken,
) -> Reconciled {
    let margin = chrono::Duration::from_std(timings.sacct_margin).unwrap_or_default();
    let since = submitted_at - margin;
    let mut empty_since: Option<Instant> = None;
    loop {
        match lookup(slurm, name, since).await {
            Ok(Some(id)) => return Reconciled::Found(id),
            Ok(None) => {
                let first = *empty_since.get_or_insert_with(Instant::now);
                if first.elapsed() >= timings.retry_window {
                    return Reconciled::Absent;
                }
            }
            Err(error) => tracing::warn!(%error, job = name, "reconciliation lookup failed"),
        }
        tokio::select! {
            _ = tokio::time::sleep(timings.poll) => {},
            _ = detach.cancelled() => return Reconciled::Detached,
        }
    }
}

async fn lookup(slurm: &Slurm, name: &str, since: DateTime<Utc>) -> Result<Option<String>, String> {
    if let Some(id) = slurm.queued_named(name).await?.into_iter().next() {
        return Ok(Some(id));
    }
    Ok(slurm.accounted_named(name, since).await?.into_iter().next())
}
