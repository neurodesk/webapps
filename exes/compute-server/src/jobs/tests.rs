use super::*;
use crate::runner::RunFuture;

struct SlowStop(Arc<tokio::sync::Notify>);

impl Runner for SlowStop {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Simulate
    }

    fn paths(&self, _dir: &Path) -> crate::tools::ToolPaths {
        crate::tools::ToolPaths::container()
    }

    fn run(&self, _request: RunRequest, context: RunContext) -> RunFuture {
        let stopped = self.0.clone();
        Box::pin(async move {
            context
                .status
                .report(RunnerEvent::Running { state: None })?;
            context.cancel.cancelled().await;
            stopped.notified().await;
            Ok(RunOutcome::Cancelled)
        })
    }
}

fn options(dir: &Path) -> StoreOptions {
    StoreOptions {
        simulated: true,
        cpu: false,
        retain: Duration::from_secs(3600),
        parallel: 1,
        data_dir: dir.to_path_buf(),
        max_download_bytes: 1024,
        profiles: Profiles::local(),
    }
}

#[tokio::test]
async fn cancellation_does_not_finish_or_delete_before_runner_exit() {
    let dir = tempfile::tempdir().unwrap();
    let job_dir = dir.path().join("jobs/id");
    std::fs::create_dir_all(job_dir.join("out")).unwrap();
    let stopped = Arc::new(tokio::sync::Notify::new());
    let store = JobStore::new(
        Arc::new(SlowStop(stopped.clone())),
        crate::tools::registry(),
        options(dir.path()),
    );
    store.start(Duration::from_secs(60));
    store
        .submit(
            SubmissionIdentity {
                owner: "owner".into(),
                key: "key".into(),
                fingerprint: "test".into(),
            },
            "id".into(),
            crate::tools::registry()[0].clone(),
            ValidatedJob {
                tool: "nesvor".into(),
                command: "reconstruct".into(),
                inputs: crate::tools::JobInputs::Nesvor { stacks: vec![] },
                options: serde_json::Map::new(),
                warnings: vec![],
            },
            job_dir.clone(),
        )
        .unwrap();
    while store.view("id").unwrap().status != Status::Running {
        tokio::task::yield_now().await;
    }
    store.cancel("id").unwrap();
    assert_eq!(store.view("id").unwrap().status, Status::Cancelling);
    assert!(store.view("id").unwrap().finished_at.is_none());
    assert_eq!(
        store.delete("id").await,
        Err(DeleteError::Conflict(
            "cancel and wait for termination before deletion"
        ))
    );
    let (events, _) = store.subscribe("id").unwrap();
    assert!(!events.iter().any(|event| matches!(event, Event::Done(_))));
    stopped.notify_one();
    while store.view("id").unwrap().status != Status::Cancelled {
        tokio::task::yield_now().await;
    }
    store.shutdown().await;
    assert!(job_dir.join("job.json").exists());
}

/// The store does not report a job running before its runner does.
#[tokio::test]
async fn a_job_is_queued_until_the_runner_reports_running() {
    struct Held(Arc<tokio::sync::Notify>);
    impl Runner for Held {
        fn kind(&self) -> RunnerKind {
            RunnerKind::Simulate
        }
        fn paths(&self, _dir: &Path) -> crate::tools::ToolPaths {
            crate::tools::ToolPaths::container()
        }
        fn run(&self, _request: RunRequest, context: RunContext) -> RunFuture {
            let release = self.0.clone();
            Box::pin(async move {
                release.notified().await;
                context
                    .status
                    .report(RunnerEvent::Running { state: None })?;
                release.notified().await;
                Ok(RunOutcome::Failed {
                    code: "scheduler-failed",
                    message: "TIMEOUT".into(),
                })
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let job_dir = dir.path().join("jobs/id");
    std::fs::create_dir_all(job_dir.join("out")).unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let store = JobStore::new(
        Arc::new(Held(release.clone())),
        crate::tools::registry(),
        options(dir.path()),
    );
    store.start(Duration::from_secs(60));
    store
        .submit(
            SubmissionIdentity {
                owner: "owner".into(),
                key: "key".into(),
                fingerprint: "test".into(),
            },
            "id".into(),
            crate::tools::registry()[0].clone(),
            ValidatedJob {
                tool: "nesvor".into(),
                command: "reconstruct".into(),
                inputs: crate::tools::JobInputs::Nesvor { stacks: vec![] },
                options: serde_json::Map::new(),
                warnings: vec![],
            },
            job_dir,
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let view = store.view("id").unwrap();
    assert_eq!(view.status, Status::Queued);
    assert_eq!(view.position, 0);
    assert!(view.started_at.is_none());
    release.notify_one();
    while store.view("id").unwrap().status != Status::Running {
        tokio::task::yield_now().await;
    }
    release.notify_one();
    while store.view("id").unwrap().status != Status::Failed {
        tokio::task::yield_now().await;
    }
    let view = store.view("id").unwrap();
    assert_eq!(view.error.unwrap().code, "scheduler-failed");
    assert!(view.scheduler.is_none());
    store.shutdown().await;
}
