//! Single-owner mode, data roots, projects and project outputs through the
//! HTTP API, with the fake project tool on the simulated runner.

use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};

use crate::roots::DataRoot;
use crate::test_support::{mrc, Harness};
use crate::tools::fake;

/// A data root `facility` with `grid3/{a,b}.tiff`, a hidden file and a
/// symlink to a file outside the root in `escape/`.
fn facility(base: &Path) -> DataRoot {
    let root = base.join("facility");
    std::fs::create_dir_all(root.join("grid3")).unwrap();
    std::fs::create_dir_all(root.join("escape")).unwrap();
    std::fs::write(root.join("grid3/a.tiff"), "a").unwrap();
    std::fs::write(root.join("grid3/b.tiff"), "b").unwrap();
    std::fs::write(root.join("grid3/.c.tiff"), "c").unwrap();
    std::fs::write(root.join("gain.mrc"), mrc()).unwrap();
    std::fs::write(base.join("secret.tiff"), "secret").unwrap();
    symlink(base.join("secret.tiff"), root.join("escape/x.tiff")).unwrap();
    symlink(base, root.join("outside")).unwrap();
    DataRoot::parse(&format!("facility={}", root.display())).unwrap()
}

async fn harness() -> Harness {
    Harness::start(|config, base| {
        config.data_roots = vec![facility(base)];
        config.max_download_bytes = 100;
    })
    .await
}

fn import(project: &str) -> Value {
    json!({
        "tool": fake::ID,
        "command": "import",
        "project": project,
        "data": { "root": "facility", "path": "grid3", "pattern": "*.tiff" },
        "options": { "bigBytes": 200 }
    })
}

fn process(project: &str, input: &str) -> Value {
    json!({
        "tool": fake::ID,
        "command": "process",
        "project": project,
        "inputs": { "particles": input },
    })
}

#[tokio::test]
async fn info_and_shared_ownership() {
    let mut server = harness().await;
    let info = server.json("/api/v1/info").await;
    assert_eq!(info["ownership"], "single");
    assert_eq!(info["features"], json!(["projects", "dataRoots"]));
    assert_eq!(
        info["dataRoots"],
        json!([{ "id": "facility", "label": "facility" }])
    );
    assert_eq!(info["profiles"][0]["name"], "local");
    assert_eq!(info["limits"]["maxDownloadBytes"], 100);
    assert!(info["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["id"] == fake::ID));
    let anonymous: Value = server
        .client
        .get(server.url("/api/v1/info"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(anonymous.get("ownership").is_none());

    let paired: Value = server
        .client
        .post(server.url("/api/v1/pair"))
        .json(&json!({ "code": crate::test_support::CODE }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(paired["clientId"], "single-owner");
    let second = paired["token"].as_str().unwrap().to_string();
    let project = server.project("shared").await;
    let listed: Value = server
        .client
        .get(server.url("/api/v1/projects"))
        .bearer_auth(&second)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["projects"][0]["id"], project.as_str());
    let revoked = server
        .client
        .delete(server.url("/api/v1/session"))
        .bearer_auth(&second)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let refused = server
        .client
        .get(server.url("/api/v1/projects"))
        .bearer_auth(&second)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        server.get("/api/v1/projects").await.status(),
        StatusCode::OK
    );
    server.restart().await;
    assert_eq!(
        server.get("/api/v1/projects").await.status(),
        StatusCode::OK
    );
    server.stop().await;
}

#[tokio::test]
async fn projects_created_in_one_second_list_newest_first() {
    let mut server = harness().await;
    let mut created = Vec::new();
    for index in 0..6 {
        created.push(server.project(&format!("project {index}")).await);
    }
    let listed = server.json("/api/v1/projects").await;
    let ids: Vec<&str> = listed["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|project| project["id"].as_str().unwrap())
        .collect();
    created.reverse();
    assert_eq!(ids, created);
    let times: Vec<&str> = listed["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|project| project["createdAt"].as_str().unwrap())
        .collect();
    assert!(
        times.windows(2).all(|pair| pair[0] > pair[1]),
        "createdAt strictly decreases: {times:?}"
    );
    server.stop().await;
}

#[tokio::test]
async fn pairing_mode_has_no_projects_or_roots() {
    let mut server = Harness::start(|config, _| config.single_owner = false).await;
    let info = server.json("/api/v1/info").await;
    assert_eq!(info["ownership"], "pairing");
    assert_eq!(info["features"], json!([]));
    assert!(info.get("dataRoots").is_none());
    assert!(info["limits"]["maxDownloadBytes"].is_u64());
    for path in [
        "/api/v1/projects",
        "/api/v1/roots",
        "/api/v1/roots/x/entries",
    ] {
        assert_eq!(
            server.get(path).await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    let response = server.submit(&import(&"0".repeat(32)), &[]).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unknown tool"));
    server.stop().await;
}

#[tokio::test]
async fn data_root_listings_and_escapes() {
    let mut server = harness().await;
    assert_eq!(
        server.json("/api/v1/roots").await,
        json!({ "roots": [{ "id": "facility", "label": "facility" }] })
    );
    let page = server
        .json("/api/v1/roots/facility/entries?path=grid3")
        .await;
    let names: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["a.tiff", "b.tiff"]);
    assert_eq!(page["entries"][0]["kind"], "file");
    assert_eq!(page["entries"][0]["bytes"], 1);
    assert!(page["next"].is_null());
    let top = server.json("/api/v1/roots/facility/entries").await;
    let names: Vec<&str> = top["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["escape", "gain.mrc", "grid3"]);
    let body = server
        .get("/api/v1/roots/facility/entries")
        .await
        .text()
        .await
        .unwrap();
    assert!(!body.contains(server.data_dir.path().to_str().unwrap()));
    for path in [
        "..",
        "grid3/..",
        "%2Fetc",
        "outside",
        "escape/x.tiff",
        "missing",
        "grid3%5Ca.tiff",
        "grid3%00",
        "grid3//a",
    ] {
        let response = server
            .get(&format!("/api/v1/roots/facility/entries?path={path}"))
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        server.get("/api/v1/roots/other/entries").await.status(),
        StatusCode::NOT_FOUND
    );
    let project = server.project("roots").await;
    for (data, reason) in [
        (
            json!({ "root": "facility", "path": "grid3", "pattern": "*/a.tiff" }),
            "'/'",
        ),
        (
            json!({ "root": "facility", "path": "../facility/grid3", "pattern": "*.tiff" }),
            "..",
        ),
        (
            json!({ "root": "facility", "path": "/etc", "pattern": "*" }),
            "absolute",
        ),
        (
            json!({ "root": "facility", "path": "escape", "pattern": "*.tiff" }),
            "symbolic link",
        ),
        (
            json!({ "root": "facility", "path": "outside", "pattern": "*.tiff" }),
            "outside",
        ),
        (
            json!({ "root": "facility", "path": "grid3", "pattern": "*.eer" }),
            "no file",
        ),
        (
            json!({ "root": "nope", "path": "grid3", "pattern": "*" }),
            "unknown data root",
        ),
        (json!({ "root": "facility", "path": "grid3" }), "not a file"),
    ] {
        let mut spec = import(&project);
        spec["data"] = data;
        let response = server.submit(&spec, &[]).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains(reason), "{message} lacks {reason}");
    }
    server.stop().await;
}

#[tokio::test]
async fn project_jobs_outputs_dependencies_and_deletion() {
    let mut server = harness().await;
    let response = server
        .client
        .post(server.url("/api/v1/projects"))
        .bearer_auth(&server.token)
        .json(&json!({ "name": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let project = server.project("Apoferritin grid 3").await;

    let first = server.accepted(&import(&project)).await;
    let job = server.wait_status(&first, "succeeded").await;
    assert_eq!(job["project"], project.as_str());
    assert_eq!(job["directory"], "Import/job001");
    assert_eq!(job["dependsOn"], json!([]));
    assert!(job["scheduler"].is_null());
    let outputs: Vec<(&str, bool)> = job["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|output| {
            (
                output["name"].as_str().unwrap(),
                output["download"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        outputs,
        vec![
            ("Import/job001/RELION_JOB_EXIT_SUCCESS", true),
            ("Import/job001/big.bin", false),
            ("Import/job001/inside-link", true),
            ("Import/job001/out.star", true),
            ("Import/job001/sub/inner.txt", true),
        ]
    );
    let star = server
        .get(&format!(
            "/api/v1/jobs/{first}/outputs/Import%2Fjob001%2Fout.star"
        ))
        .await;
    assert_eq!(star.status(), StatusCode::OK);
    assert_eq!(
        star.headers()["content-disposition"],
        "attachment; filename=\"out.star\""
    );
    let text = star.text().await.unwrap();
    assert!(text.contains("/data/facility/grid3/a.tiff"), "{text}");
    assert!(text.contains("/data/facility/grid3/b.tiff"), "{text}");
    let nested = server
        .get(&format!(
            "/api/v1/jobs/{first}/outputs/Import/job001/sub/inner.txt"
        ))
        .await;
    assert_eq!(nested.status(), StatusCode::OK);
    assert_eq!(nested.text().await.unwrap(), "inner");
    let big = server
        .get(&format!(
            "/api/v1/jobs/{first}/outputs/Import/job001/big.bin"
        ))
        .await;
    assert_eq!(big.status(), StatusCode::PAYLOAD_TOO_LARGE);
    for name in [
        "Import/job001/escape-link",
        "Import/job001/../../../token",
        "Import%2Fjob001%2F..%2F..%2F..%2Ftoken",
        "Import/job001",
        "out.star",
    ] {
        let response = server
            .get(&format!("/api/v1/jobs/{first}/outputs/{name}"))
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{name}");
    }

    let rejected = server
        .submit(&process(&project, "Import/job001/missing.star"), &[])
        .await;
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let rejected = server
        .submit(&process(&project, "Import/job001/../job001/out.star"), &[])
        .await;
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let mut masked = process(&project, "Import/job001/out.star");
    masked["parts"] = json!(["mask"]);
    let not_mrc = server
        .submit(&masked, &[("mask", b"not an mrc".to_vec())])
        .await;
    assert_eq!(not_mrc.status(), StatusCode::BAD_REQUEST);
    let response = server.submit(&masked, &[("mask", mrc())]).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let second: Value = response.json().await.unwrap();
    let second = second["id"].as_str().unwrap().to_string();
    let job = server.wait_status(&second, "succeeded").await;
    assert_eq!(job["directory"], "Process/job002");
    assert_eq!(job["dependsOn"], json!([first]));
    let project_dir = server.data().join("projects").join(&project);
    assert_eq!(
        std::fs::read(project_dir.join("Process/job002/mask.mrc")).unwrap(),
        mrc()
    );
    let star = server
        .get(&format!(
            "/api/v1/jobs/{second}/outputs/Process/job002/out.star"
        ))
        .await
        .text()
        .await
        .unwrap();
    assert!(star.contains("Import/job001/out.star"));
    assert!(star.contains("Process/job002/mask.mrc"));

    let mut failing = process(&project, "Import/job001/out.star");
    failing["options"] = json!({ "fail": true });
    let failed = server.accepted(&failing).await;
    let job = server.wait_status(&failed, "failed").await;
    assert_eq!(job["directory"], "Process/job003");
    assert_eq!(job["error"]["code"], "tool-failed");
    assert!(job["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|output| output["name"] == "Process/job003/RELION_JOB_EXIT_FAILURE"));
    let rejected = server
        .submit(&process(&project, "Process/job003/sub/inner.txt"), &[])
        .await;
    assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    let mut silent = process(&project, "Import/job001/out.star");
    silent["options"] = json!({ "skipOutput": true });
    let silent = server.accepted(&silent).await;
    let job = server.wait_status(&silent, "failed").await;
    assert!(job["error"]["message"]
        .as_str()
        .unwrap()
        .contains("out.star"));

    let detail = server.json(&format!("/api/v1/projects/{project}")).await;
    let directories: Vec<&str> = detail["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|job| job["directory"].as_str().unwrap())
        .collect();
    assert_eq!(
        directories,
        vec![
            "Import/job001",
            "Process/job002",
            "Process/job003",
            "Process/job004"
        ]
    );
    assert_eq!(detail["jobs"][1]["dependsOn"], json!([first]));
    assert_eq!(
        server.json("/api/v1/projects").await["projects"][0]["jobCount"],
        4
    );

    server.running.as_ref().unwrap().store.sweep().await;
    assert_eq!(
        server.get(&format!("/api/v1/jobs/{first}")).await.status(),
        StatusCode::OK
    );
    server.restart().await;
    let job = server.json(&format!("/api/v1/jobs/{second}")).await;
    assert_eq!(job["dependsOn"], json!([first]));
    assert_eq!(job["outputs"].as_array().unwrap().len(), 5);
    let third = server
        .accepted(&process(&project, "Process/job002/out.star"))
        .await;
    let job = server.wait_status(&third, "succeeded").await;
    assert_eq!(job["directory"], "Process/job005");
    assert_eq!(job["dependsOn"], json!([second]));

    let conflict = server.delete(&format!("/api/v1/jobs/{first}")).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    for id in [&third, &second, &failed, &silent] {
        assert_eq!(
            server.delete(&format!("/api/v1/jobs/{id}")).await.status(),
            StatusCode::NO_CONTENT
        );
    }
    assert!(!project_dir.join("Process/job002").exists());
    assert_eq!(
        server
            .delete(&format!("/api/v1/jobs/{first}"))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!project_dir.join("Import/job001").exists());

    let mut slow = import(&project);
    slow["options"] = json!({});
    let active = server.accepted(&slow).await;
    let busy = server.delete(&format!("/api/v1/projects/{project}")).await;
    assert_eq!(busy.status(), StatusCode::CONFLICT);
    server.wait_status(&active, "succeeded").await;
    assert_eq!(
        server
            .delete(&format!("/api/v1/projects/{project}"))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(!project_dir.exists());
    assert_eq!(
        server.get(&format!("/api/v1/jobs/{active}")).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(server.json("/api/v1/projects").await["projects"], json!([]));
    server.restart().await;
    assert_eq!(server.json("/api/v1/projects").await["projects"], json!([]));
    assert_eq!(
        std::fs::read_dir(server.data().join("jobs"))
            .unwrap()
            .count(),
        0
    );
    server.stop().await;
}

#[tokio::test]
async fn profiles_and_launch_plans_are_checked_at_submission() {
    let mut server = harness().await;
    let project = server.project("profiles").await;
    let mut spec = import(&project);
    spec["profile"] = json!("gpu-4");
    let response = server.submit(&spec, &[]).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let mut spec = import(&project);
    spec["options"] = json!({ "needGpus": 1 });
    let response = server.submit(&spec, &[]).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().contains("GPUs"));
    let mut spec = import(&project);
    spec["project"] = json!("f".repeat(32));
    assert_eq!(
        server.submit(&spec, &[]).await.status(),
        StatusCode::BAD_REQUEST
    );
    let job = server.accepted(&import(&project)).await;
    let job = server.wait_status(&job, "succeeded").await;
    let record: Value = serde_json::from_slice(
        &std::fs::read(
            server
                .data()
                .join("jobs")
                .join(job["id"].as_str().unwrap())
                .join("job.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(record["validated"]["project"]["profile"], "local");
    assert_eq!(
        record["validated"]["project"]["data"][0]["directory"],
        "/data/facility/grid3"
    );
    server.stop().await;
}

#[tokio::test]
async fn cancelled_project_jobs_keep_their_files() {
    let mut server = harness().await;
    let project = server.project("cancel").await;
    let id = server.accepted(&import(&project)).await;
    server.wait_status(&id, "running").await;
    let cancelled = server.post(&format!("/api/v1/jobs/{id}/cancel")).await;
    assert_eq!(cancelled.status(), StatusCode::OK);
    let job = server.wait_status(&id, "cancelled").await;
    assert_eq!(job["directory"], "Import/job001");
    tokio::time::sleep(Duration::from_millis(50)).await;
    server.stop().await;
}

#[tokio::test]
async fn a_job_directory_swapped_for_a_symlink_serves_nothing() {
    let mut server = harness().await;
    let project = server.project("swap").await;
    let id = server.accepted(&import(&project)).await;
    server.wait_status(&id, "succeeded").await;
    let job_dir = server
        .data()
        .join("projects")
        .join(&project)
        .join("Import/job001");
    let outside = server.data_dir.path().join("outside-job");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("out.star"), "outside").unwrap();
    std::fs::rename(&job_dir, server.data_dir.path().join("moved-job")).unwrap();
    symlink(&outside, &job_dir).unwrap();
    let response = server
        .get(&format!("/api/v1/jobs/{id}/outputs/Import/job001/out.star"))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    server.stop().await;
}
