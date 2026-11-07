//! The Slurm runner end to end: an in-process single-owner server with the
//! fake project tool, against fake Slurm commands first on the runner's `PATH`.

use std::path::Path;
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};

use super::fake::FakeSlurm;
use super::{SlurmConfig, SlurmSettings, SlurmTimings};
use crate::config::RunnerKind;
use crate::roots::DataRoot;
use crate::test_support::Harness;
use crate::tools::fake;

fn timings() -> SlurmTimings {
    SlurmTimings {
        poll: Duration::from_millis(40),
        sacct_margin: Duration::from_secs(300),
        retry_window: Duration::from_millis(600),
        marker_grace: Duration::from_millis(300),
        unavailable_after: Duration::from_millis(200),
        tail: Duration::from_millis(20),
        command_timeout: Duration::from_secs(5),
    }
}

fn slurm_config(base: &Path) -> SlurmConfig {
    let image = base.join("relion.sif");
    std::fs::write(&image, "not really a SIF").unwrap();
    let sha = crate::api::hex_digest(ring::digest::digest(
        &ring::digest::SHA256,
        b"not really a SIF",
    ));
    SlurmConfig::parse(
        &json!({
            "apptainer": "/usr/bin/apptainer",
            "image": { "path": image, "sha256": sha },
            "scratch": "$TMPDIR",
            "profiles": {
                "cpu": { "cpus": 4, "gpus": 0, "memory": "8G", "time": "01:00:00" },
                "gpu-2": { "partition": "gpu", "account": "lab", "cpus": 8, "gpus": 2, "memory": "32G", "time": "02:00:00" }
            },
            "defaults": { "import": "cpu", "process": "gpu-2" }
        })
        .to_string(),
    )
    .unwrap()
}

/// Configures a Slurm-mode server with a `facility` root and fake Slurm.
fn configure(config: &mut crate::config::ServeConfig, base: &Path, parallel: usize) {
    let fake = FakeSlurm::new(&base.join("slurm"));
    let root = base.join("facility");
    std::fs::create_dir_all(root.join("grid3")).unwrap();
    std::fs::write(root.join("grid3/a.tiff"), "a").unwrap();
    let slurm = slurm_config(base);
    config.runner = RunnerKind::Slurm;
    config.parallel = parallel;
    config.profiles = slurm.profiles.clone();
    config.data_roots = vec![DataRoot::parse(&format!("facility={}", root.display())).unwrap()];
    config.slurm = Some(SlurmSettings {
        config: slurm,
        timings: timings(),
        path: Some(fake.path()),
        user: "tester".into(),
    });
}

async fn cluster(parallel: usize) -> (Harness, FakeSlurm) {
    let harness = Harness::start(|config, base| configure(config, base, parallel)).await;
    let fake = FakeSlurm::new(&harness.data_dir.path().join("slurm"));
    (harness, fake)
}

fn import(project: &str) -> Value {
    json!({
        "tool": fake::ID,
        "command": "import",
        "project": project,
        "data": { "root": "facility", "path": "grid3", "pattern": "*.tiff" },
    })
}

/// Waits until the job satisfies `done`.
async fn until(harness: &Harness, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let job = harness.json(&format!("/api/v1/jobs/{id}")).await;
        if done(&job) {
            return job;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "job {id} stuck: {job}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Submits an import and waits until Slurm has accepted it.
async fn accepted(
    harness: &Harness,
    fake: &FakeSlurm,
    project: &str,
) -> (String, String, std::path::PathBuf) {
    let id = harness.accepted(&import(project)).await;
    let job = until(harness, &id, |job| !job["scheduler"].is_null()).await;
    let slurm_id = job["scheduler"]["id"].as_str().unwrap().to_string();
    assert_eq!(fake.id_of(&id).as_deref(), Some(slurm_id.as_str()));
    let dir = harness
        .data()
        .join("projects")
        .join(project)
        .join(job["directory"].as_str().unwrap());
    (id, slurm_id, dir)
}

fn succeed(fake: &FakeSlurm, slurm_id: &str, dir: &Path) {
    std::fs::write(dir.join("out.star"), "data_\n").unwrap();
    std::fs::write(dir.join(super::SUCCESS_MARKER), "").unwrap();
    fake.finish(slurm_id, "COMPLETED", "0:0");
}

#[tokio::test]
async fn startup_checks_info_and_refusals() {
    let (mut harness, fake) = cluster(4).await;
    let calls = fake.calls();
    for command in super::commands::COMMANDS {
        assert!(calls.contains(&format!("{command} --version")), "{calls:?}");
    }
    assert!(calls
        .iter()
        .any(|call| call.starts_with("sacct -u tester -S ")));
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("sbatch --test-only"))
            .count(),
        2
    );
    assert!(harness.data().join("image-verified.json").exists());
    let info = harness.json("/api/v1/info").await;
    assert_eq!(info["runner"], "slurm");
    assert_eq!(
        info["features"],
        json!(["projects", "dataRoots", "scheduler"])
    );
    assert_eq!(
        info["profiles"],
        json!([
            { "name": "cpu", "summary": "4 CPUs, 8G, 01:00:00" },
            { "name": "gpu-2", "summary": "2 GPUs, 8 CPUs, 32G, 02:00:00" }
        ])
    );
    let tools: Vec<&str> = info["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["id"].as_str().unwrap())
        .collect();
    assert_eq!(tools, vec![fake::ID]);
    harness.stop().await;

    fake.mode("test_only_fail", Some(""));
    let error = harness.boot().await.err().unwrap().to_string();
    assert!(error.contains("--test-only refuses profile"), "{error}");
    fake.mode("test_only_fail", None);

    let mut wrong = harness.config.clone();
    if let Some(slurm) = wrong.slurm.as_mut() {
        slurm.config.image_sha256 = "0".repeat(64);
    }
    let tools = crate::tools::available(&wrong, crate::test_support::tools());
    let error = crate::server::start_with_tools(wrong, tools)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("SHA-256"), "{error}");

    for (change, message) in [
        (
            Box::new(|config: &mut crate::config::ServeConfig| config.listen = "0.0.0.0:0".into())
                as Box<dyn Fn(&mut crate::config::ServeConfig)>,
            "loopback",
        ),
        (
            Box::new(|config| config.single_owner = false),
            "--single-owner",
        ),
        (Box::new(|config| config.slurm = None), "--slurm-config"),
    ] {
        let mut config = harness.config.clone();
        change(&mut config);
        let error = crate::server::validate(&config).err().unwrap().to_string();
        assert!(error.contains(message), "{error}");
    }
    harness.boot().await.unwrap();
    harness.stop().await;
}

#[tokio::test]
async fn a_job_runs_through_pending_running_and_success() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("slurm").await;
    let (id, slurm_id, dir) = accepted(&harness, &fake, &project).await;
    let job = until(&harness, &id, |job| {
        job["message"] == "Waiting in the cluster queue (Priority)"
    })
    .await;
    assert_eq!(job["status"], "queued");
    assert_eq!(job["position"], 0);
    assert_eq!(job["scheduler"]["state"], "PENDING");
    assert_eq!(job["message"], "Waiting in the cluster queue (Priority)");
    let script = std::fs::read_to_string(dir.join("job.sbatch")).unwrap();
    assert_eq!(script, fake.kept(&slurm_id, "script"));
    assert!(script.contains(&format!("#SBATCH --job-name=nd-{id}\n")));
    assert!(script.contains(&format!("#SBATCH --output={}/run.out\n", dir.display())));
    assert!(script.contains("#SBATCH --cpus-per-task=4\n"));
    assert!(script.contains(":/data/facility:ro'"));
    assert!(script.contains("\nrun 'fake_relion' '--o' 'Import/job001/'"));
    assert!(fake
        .calls()
        .iter()
        .any(|call| call == &format!("sbatch --parsable {}/job.sbatch", dir.display())));

    fake.queue(&slurm_id, "RUNNING", None);
    let job = harness.wait_status(&id, "running").await;
    assert_eq!(job["scheduler"]["state"], "RUNNING");
    assert!(job["startedAt"].is_string());
    std::fs::write(dir.join("run.out"), "progress 0.25\nhello from the node\n").unwrap();
    std::fs::write(dir.join("run.err"), "ERROR not really\n").unwrap();
    let job = until(&harness, &id, |job| job["progress"] == 0.25).await;
    assert_eq!(job["stage"], "Fake");
    succeed(&fake, &slurm_id, &dir);
    let job = harness.wait_status(&id, "succeeded").await;
    let names: Vec<&str> = job["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|output| output["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "Import/job001/RELION_JOB_EXIT_SUCCESS",
            "Import/job001/job.sbatch",
            "Import/job001/out.star",
            "Import/job001/run.err",
            "Import/job001/run.out",
        ]
    );
    let events = harness
        .get(&format!("/api/v1/jobs/{id}/events"))
        .await
        .text()
        .await
        .unwrap();
    assert!(events.contains("hello from the node"));
    assert!(events.contains("\"level\":\"error\""));
    assert!(fake.cancelled().is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn every_terminal_state_maps_as_the_adr_says() {
    let (mut harness, fake) = cluster(16).await;
    let project = harness.project("states").await;
    struct Case {
        slurm: &'static str,
        exit: &'static str,
        marker: Option<&'static str>,
        out: bool,
        status: &'static str,
        code: Option<&'static str>,
        message: &'static str,
    }
    let cases = [
        Case {
            slurm: "COMPLETED",
            exit: "0:0",
            marker: Some(super::SUCCESS_MARKER),
            out: true,
            status: "succeeded",
            code: None,
            message: "",
        },
        Case {
            slurm: "COMPLETED",
            exit: "0:0",
            marker: Some(super::FAILURE_MARKER),
            out: true,
            status: "failed",
            code: Some("tool-failed"),
            message: super::FAILURE_MARKER,
        },
        Case {
            slurm: "COMPLETED",
            exit: "0:0",
            marker: None,
            out: true,
            status: "failed",
            code: Some("tool-failed"),
            message: "no RELION_JOB_EXIT_SUCCESS",
        },
        Case {
            slurm: "COMPLETED",
            exit: "0:0",
            marker: Some(super::SUCCESS_MARKER),
            out: false,
            status: "failed",
            code: Some("tool-failed"),
            message: "did not write out.star",
        },
        Case {
            slurm: "CANCELLED",
            exit: "0:15",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "CANCELLED (exit 0:15)",
        },
        Case {
            slurm: "FAILED",
            exit: "1:0",
            marker: Some(super::FAILURE_MARKER),
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "FAILED (exit 1:0)",
        },
        Case {
            slurm: "TIMEOUT",
            exit: "0:15",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "TIMEOUT (exit 0:15)",
        },
        Case {
            slurm: "OUT_OF_MEMORY",
            exit: "0:125",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "OUT_OF_MEMORY (exit 0:125)",
        },
        Case {
            slurm: "NODE_FAIL",
            exit: "0:0",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "NODE_FAIL",
        },
        Case {
            slurm: "PREEMPTED",
            exit: "0:0",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "PREEMPTED",
        },
        Case {
            slurm: "BOOT_FAIL",
            exit: "0:0",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "BOOT_FAIL",
        },
        Case {
            slurm: "DEADLINE",
            exit: "0:0",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "DEADLINE",
        },
        Case {
            slurm: "REVOKED",
            exit: "0:0",
            marker: None,
            out: false,
            status: "failed",
            code: Some("scheduler-failed"),
            message: "REVOKED",
        },
    ];
    let mut jobs = Vec::new();
    for case in &cases {
        jobs.push(accepted(&harness, &fake, &project).await);
        let (_, slurm_id, dir) = jobs.last().unwrap();
        fake.queue(slurm_id, "RUNNING", None);
        if case.out {
            std::fs::write(dir.join("out.star"), "data_\n").unwrap();
        }
        if let Some(marker) = case.marker {
            std::fs::write(dir.join(marker), "").unwrap();
        }
    }
    for ((_, slurm_id, _), case) in jobs.iter().zip(&cases) {
        fake.finish(slurm_id, case.slurm, case.exit);
    }
    let fallback = accepted(&harness, &fake, &project).await;
    std::fs::write(fallback.2.join("out.star"), "data_\n").unwrap();
    std::fs::write(fallback.2.join(super::SUCCESS_MARKER), "").unwrap();
    fake.control(&fallback.1, "COMPLETED", "0:0");
    fake.leave_queue(&fallback.1);
    let lost = accepted(&harness, &fake, &project).await;
    fake.leave_queue(&lost.1);
    for ((id, _, _), case) in jobs.iter().zip(&cases) {
        let job = until(&harness, id, |job| {
            ["succeeded", "failed", "cancelled"].contains(&job["status"].as_str().unwrap())
        })
        .await;
        assert_eq!(job["status"], case.status, "{} {job}", case.slurm);
        assert_eq!(
            job["error"]["code"].as_str(),
            case.code,
            "{} {job}",
            case.slurm
        );
        let message = job["error"]["message"].as_str().unwrap_or("");
        assert!(message.contains(case.message), "{}: {message}", case.slurm);
    }
    harness.wait_status(&fallback.0, "succeeded").await;
    let job = harness.wait_status(&lost.0, "failed").await;
    assert_eq!(job["error"]["code"], "scheduler-lost");
    assert!(fake.cancelled().is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn cancelling_pending_jobs_waits_for_accounting() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("cancel").await;
    let (id, slurm_id, _) = accepted(&harness, &fake, &project).await;
    fake.mode("scancel_noop", Some(""));
    let response = harness.post(&format!("/api/v1/jobs/{id}/cancel")).await;
    assert_eq!(response.status(), StatusCode::OK);
    until(&harness, &id, |_| {
        fake.cancelled() == vec![slurm_id.clone()]
    })
    .await;
    let job = harness.json(&format!("/api/v1/jobs/{id}")).await;
    assert_eq!(job["status"], "cancelling");
    assert_eq!(
        harness.delete(&format!("/api/v1/jobs/{id}")).await.status(),
        StatusCode::CONFLICT
    );
    fake.finish(&slurm_id, "CANCELLED", "0:15");
    harness.wait_status(&id, "cancelled").await;
    assert_eq!(
        harness.delete(&format!("/api/v1/jobs/{id}")).await.status(),
        StatusCode::NO_CONTENT
    );

    fake.mode("scancel_noop", None);
    let (running, slurm_id, _) = accepted(&harness, &fake, &project).await;
    fake.queue(&slurm_id, "RUNNING", None);
    harness.wait_status(&running, "running").await;
    harness
        .post(&format!("/api/v1/jobs/{running}/cancel"))
        .await;
    harness.wait_status(&running, "cancelled").await;
    harness.stop().await;
}

#[tokio::test]
async fn lost_sbatch_answers_are_reconciled_by_name() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("lost").await;
    fake.mode("sbatch", Some("lose"));
    let (id, slurm_id, dir) = accepted(&harness, &fake, &project).await;
    assert!(fake
        .calls()
        .iter()
        .any(|call| call == &format!("squeue --me --noheader --name nd-{id} --format=%i")));
    succeed(&fake, &slurm_id, &dir);
    harness.wait_status(&id, "succeeded").await;

    fake.mode("initial_queue", Some("none"));
    fake.mode("unaccounted", Some(""));
    let delayed = harness.accepted(&import(&project)).await;
    until(&harness, &delayed, |_| fake.id_of(&delayed).is_some()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let job = harness.json(&format!("/api/v1/jobs/{delayed}")).await;
    assert_eq!(job["status"], "queued");
    assert!(job["scheduler"].is_null());
    let slurm_id = fake.id_of(&delayed).unwrap();
    fake.accounted(&slurm_id, true);
    fake.account(&slurm_id, "PENDING", "0:0");
    let job = until(&harness, &delayed, |job| !job["scheduler"].is_null()).await;
    assert_eq!(job["scheduler"]["id"], slurm_id.as_str());
    fake.control(&slurm_id, "COMPLETED", "0:0");
    let dir = harness
        .data()
        .join("projects")
        .join(&project)
        .join(job["directory"].as_str().unwrap());
    succeed(&fake, &slurm_id, &dir);
    harness.wait_status(&delayed, "succeeded").await;

    let never = harness.accepted(&import(&project)).await;
    until(&harness, &never, |_| fake.id_of(&never).is_some()).await;
    let job = harness.wait_status(&never, "failed").await;
    assert_eq!(job["error"]["code"], "interrupted");
    assert_eq!(
        fake.calls()
            .iter()
            .filter(|call| call.starts_with("sbatch --parsable"))
            .count(),
        3
    );
    harness.stop().await;
}

#[tokio::test]
async fn a_job_accepted_before_midnight_is_found_after_it() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("midnight").await;
    fake.mode("sbatch", Some("lose"));
    fake.mode("initial_queue", Some("none"));
    let tomorrow = chrono::Local::now().date_naive() + chrono::Days::new(1);
    fake.today(&format!("{tomorrow}T00:00:00"));
    let id = harness.accepted(&import(&project)).await;
    let job = until(&harness, &id, |job| !job["scheduler"].is_null()).await;
    let slurm_id = job["scheduler"]["id"].as_str().unwrap().to_string();
    let lookup = fake
        .calls()
        .into_iter()
        .find(|call| call.starts_with(&format!("sacct -u tester --name nd-{id} -S ")))
        .unwrap();
    let start = lookup
        .split(" -S ")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap()
        .to_string();
    let submitted = fake.kept(&slurm_id, "submitted");
    assert!(start.as_str() < submitted.trim(), "{start} vs {submitted}");
    let dir = harness
        .data()
        .join("projects")
        .join(&project)
        .join(job["directory"].as_str().unwrap());
    succeed(&fake, &slurm_id, &dir);
    harness.wait_status(&id, "succeeded").await;
    harness.stop().await;
}

#[tokio::test]
async fn cancelling_while_submitting_resolves_after_reconciliation() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("submitting").await;
    fake.mode("sbatch", Some("lose"));
    fake.mode("initial_queue", Some("none"));
    fake.mode("unaccounted", Some(""));
    let found = harness.accepted(&import(&project)).await;
    until(&harness, &found, |_| fake.id_of(&found).is_some()).await;
    harness.post(&format!("/api/v1/jobs/{found}/cancel")).await;
    let job = harness.json(&format!("/api/v1/jobs/{found}")).await;
    assert_eq!(job["status"], "cancelling");
    let record: Value = serde_json::from_slice(
        &std::fs::read(harness.data().join("jobs").join(&found).join("job.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(record["cancel_requested"], true);
    let slurm_id = fake.id_of(&found).unwrap();
    fake.accounted(&slurm_id, true);
    fake.queue(&slurm_id, "PENDING", Some("Priority"));
    harness.wait_status(&found, "cancelled").await;
    assert_eq!(fake.cancelled(), vec![slurm_id]);

    let absent = harness.accepted(&import(&project)).await;
    until(&harness, &absent, |_| fake.id_of(&absent).is_some()).await;
    harness.post(&format!("/api/v1/jobs/{absent}/cancel")).await;
    let job = harness.wait_status(&absent, "cancelled").await;
    assert!(job["error"].is_null());
    assert_eq!(fake.cancelled().len(), 1);
    harness.stop().await;
}

#[tokio::test]
async fn a_crash_between_sbatch_and_saving_the_id_is_reconciled() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("crash").await;
    fake.mode("sbatch", Some("hang"));
    let id = harness.accepted(&import(&project)).await;
    until(&harness, &id, |_| fake.id_of(&id).is_some()).await;
    let record_path = harness.data().join("jobs").join(&id).join("job.json");
    let record: Value = serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(record["state"], "submitting");
    assert!(record["submitted_at"].is_string());
    assert!(record["view"]["scheduler"].is_null());
    harness.stop().await;
    fake.mode("sbatch", None);
    harness.boot().await.unwrap();
    let job = until(&harness, &id, |job| !job["scheduler"].is_null()).await;
    let slurm_id = fake.id_of(&id).unwrap();
    assert_eq!(job["scheduler"]["id"], slurm_id.as_str());
    let dir = harness
        .data()
        .join("projects")
        .join(&project)
        .join(job["directory"].as_str().unwrap());
    succeed(&fake, &slurm_id, &dir);
    harness.wait_status(&id, "succeeded").await;
    assert_eq!(fake.ids().len(), 1);
    assert_eq!(
        fake.calls()
            .iter()
            .filter(|call| call.starts_with("sbatch --parsable"))
            .count(),
        1
    );
    harness.stop().await;
}

#[tokio::test]
async fn shutdown_detaches_and_restart_reattaches() {
    let (mut harness, fake) = cluster(1).await;
    let project = harness.project("restart").await;
    let (id, slurm_id, dir) = accepted(&harness, &fake, &project).await;
    let waiting = harness.accepted(&import(&project)).await;
    let job = harness.json(&format!("/api/v1/jobs/{waiting}")).await;
    assert_eq!(job["position"], 1);
    assert!(job["scheduler"].is_null());
    fake.queue(&slurm_id, "RUNNING", None);
    harness.wait_status(&id, "running").await;
    std::fs::write(dir.join("run.out"), "first line before restart\n").unwrap();
    until(&harness, &id, |job| {
        job["message"] == "first line before restart"
    })
    .await;
    harness.stop().await;
    assert!(fake.cancelled().is_empty());
    assert_eq!(fake.ids(), vec![slurm_id.clone()]);
    assert!(!harness.data().join(crate::instance::INSTANCE_LOCK).exists());
    std::fs::write(
        dir.join("run.out"),
        "first line before restart\nsecond line after\n",
    )
    .unwrap();
    harness.boot().await.unwrap();
    let job = harness.json(&format!("/api/v1/jobs/{id}")).await;
    assert_eq!(job["status"], "running");
    assert_eq!(job["scheduler"]["id"], slurm_id.as_str());
    until(&harness, &id, |job| job["message"] == "second line after").await;
    let events = harness.get(&format!("/api/v1/jobs/{id}/events")).await;
    let reader = tokio::spawn(events.text());
    let job = harness.json(&format!("/api/v1/jobs/{waiting}")).await;
    assert_eq!(job["status"], "queued");
    assert!(
        job["scheduler"].is_null(),
        "parallel 1 holds the second job"
    );
    succeed(&fake, &slurm_id, &dir);
    harness.wait_status(&id, "succeeded").await;
    let text = tokio::time::timeout(Duration::from_secs(10), reader)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(text.contains("first line before restart"));
    assert!(text.contains("second line after"));
    let job = until(&harness, &waiting, |job| !job["scheduler"].is_null()).await;
    assert_eq!(job["directory"], "Import/job002");
    harness.stop().await;
}

#[tokio::test]
async fn persistent_polling_failures_refuse_new_submissions() {
    let (mut harness, fake) = cluster(4).await;
    let project = harness.project("unavailable").await;
    let (id, _, _) = accepted(&harness, &fake, &project).await;
    fake.mode("squeue_fail", Some(""));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let response = harness.submit(&import(&project), &[]).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "runner-unavailable");
    let job = harness.json(&format!("/api/v1/jobs/{id}")).await;
    assert_eq!(job["status"], "queued");
    assert_eq!(job["scheduler"]["state"], "PENDING");
    fake.mode("squeue_fail", None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    harness.accepted(&import(&project)).await;
    harness.stop().await;
}

#[tokio::test]
async fn one_instance_per_data_directory() {
    let (mut harness, _fake) = cluster(1).await;
    let lock = harness.data().join(crate::instance::INSTANCE_LOCK);
    let holder: Value = serde_json::from_slice(&std::fs::read(&lock).unwrap()).unwrap();
    assert_eq!(holder["pid"], std::process::id());
    let config = harness.config.clone();
    let tools = crate::tools::available(&config, crate::test_support::tools());
    let error = crate::server::start_with_tools(config, tools)
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("already in use"), "{error}");
    harness.stop().await;
    assert!(!lock.exists());

    std::fs::write(
        &lock,
        json!({ "host": "login9", "pid": 31337, "startedAt": "2026-11-06T22:00:00Z" }).to_string(),
    )
    .unwrap();
    let start = || {
        let config = harness.config.clone();
        let tools = crate::tools::available(&config, crate::test_support::tools());
        crate::server::start_with_tools(config, tools)
    };
    let (first, second) = tokio::join!(start(), start());
    for result in [first, second] {
        let error = result.err().unwrap().to_string();
        assert!(error.contains("login9 (pid 31337"), "{error}");
    }
    assert!(lock.exists());
    assert!(crate::instance::unlock(&harness.data())
        .unwrap()
        .contains("login9"));
    harness.boot().await.unwrap();
    assert!(crate::instance::unlock(&harness.data())
        .unwrap_err()
        .contains("still holds"));
    harness.stop().await;
}

#[tokio::test]
async fn check_slurm_reports_every_node_check() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeSlurm::new(&dir.path().join("slurm"));
    let mut config = crate::config::ServeConfig::simulated(dir.path().join("data"), "x");
    configure(&mut config, dir.path(), 1);
    let settings = config.slurm.clone().unwrap();
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    for (verdict, passed) in [("pass", true), ("fail", false)] {
        let hook = fake.mode_path("on_submit");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/bash\nout=$(sed -n 's/^#SBATCH --output=//p' \"$2\")\nprintf 'PROBE image pass\\nPROBE data-root:facility pass\\nPROBE projects pass\\nPROBE tmp pass\\nPROBE isolation {verdict}\\nPROBE gpus pass 2 visible\\n' > \"$out\"\n"
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        fake.mode("initial_queue", Some("none"));
        fake.mode("initial_sacct", Some("COMPLETED|0:0"));
        let report = super::probe::check(
            &settings,
            &data_dir,
            &config.data_roots,
            "gpu-2",
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        let text = report.render();
        assert_eq!(report.passed(), passed, "{text}");
        for check in [
            "image",
            "data-root:facility",
            "projects",
            "tmp",
            "isolation",
            "gpus",
        ] {
            assert!(text.contains(&format!("] {check}: ")), "{text}");
        }
        assert_eq!(text.contains("probe output kept"), !passed, "{text}");
    }
    let slurm_id = fake.ids()[0].clone();
    let env = fake.kept(&slurm_id, "env");
    for name in super::probe::BIND_VARIABLES {
        assert!(
            env.contains(&format!(
                "{name}={}",
                data_dir.join("slurm-checks").display()
            )),
            "{env}"
        );
    }
    let script = fake.kept(&slurm_id, "script");
    assert!(script.contains("env -i"));
    assert!(script.contains(" --nv "));
    assert!(script.contains("#SBATCH --gres=gpu:2"));
    assert!(script.contains("check isolation"));
    assert!(script.contains("/token"));
    let error = super::probe::check(&settings, &data_dir, &[], "nope", Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(error.contains("unknown profile"));
}
