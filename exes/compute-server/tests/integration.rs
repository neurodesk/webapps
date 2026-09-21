//! End-to-end tests against an in-process server with the simulate runner.

use std::io::{Read, Write};
use std::time::Duration;

use compute_server::config::ServeConfig;
use compute_server::server::{self, Running};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use reqwest::multipart::{Form, Part};
use reqwest::StatusCode;
use serde_json::{json, Value};

const TOKEN: &str = "test-token";

struct TestServer {
    running: Running,
    _data_dir: tempfile::TempDir,
    client: reqwest::Client,
}

impl TestServer {
    async fn start_with(configure: impl FnOnce(&mut ServeConfig)) -> TestServer {
        let data_dir = tempfile::tempdir().expect("temp dir");
        let mut config = ServeConfig::simulated(data_dir.path().to_path_buf(), TOKEN);
        configure(&mut config);
        let running = server::start(config).await.expect("server starts");
        TestServer {
            running,
            _data_dir: data_dir,
            client: reqwest::Client::new(),
        }
    }

    async fn start() -> TestServer {
        TestServer::start_with(|_| {}).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.running.base_url("http"), path)
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(self.url(path)).bearer_auth(TOKEN)
    }

    async fn post_job(&self, spec: &Value, files: &[(&str, Vec<u8>)]) -> reqwest::Response {
        let mut form = Form::new().part(
            "spec",
            Part::text(spec.to_string())
                .mime_str("application/json")
                .unwrap(),
        );
        for (name, bytes) in files {
            form = form.part(
                name.to_string(),
                Part::bytes(bytes.clone()).file_name("upload.bin"),
            );
        }
        self.client
            .post(self.url("/api/v1/jobs"))
            .bearer_auth(TOKEN)
            .multipart(form)
            .send()
            .await
            .expect("post")
    }

    async fn stop(self) {
        self.running.shutdown().await;
    }
}

/// A 4x4x4 float32 little-endian NIfTI-1 volume filled with `value`, gzipped.
fn nifti_gz(value: f32) -> Vec<u8> {
    let plain = nifti_plain(value);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&plain).unwrap();
    encoder.finish().unwrap()
}

fn nifti_plain(value: f32) -> Vec<u8> {
    let mut bytes = vec![0u8; 352];
    bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
    let dim: [i16; 8] = [3, 4, 4, 4, 1, 1, 1, 1];
    for (index, entry) in dim.iter().enumerate() {
        bytes[40 + index * 2..42 + index * 2].copy_from_slice(&entry.to_le_bytes());
    }
    bytes[70..72].copy_from_slice(&16i16.to_le_bytes());
    bytes[72..74].copy_from_slice(&32i16.to_le_bytes());
    for index in 0..4usize {
        bytes[76 + index * 4..80 + index * 4].copy_from_slice(&1f32.to_le_bytes());
    }
    bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
    bytes[344..348].copy_from_slice(b"n+1\0");
    for _ in 0..64 {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn spec(stacks: usize, iterations: u64) -> Value {
    let stacks: Vec<Value> = (0..stacks)
        .map(|index| json!({ "file": format!("stack-{index}"), "thickness": 3.0 }))
        .collect();
    json!({
        "tool": "nesvor",
        "command": "reconstruct",
        "stacks": stacks,
        "options": { "iterations": iterations, "segmentation": true, "biasFieldCorrection": true }
    })
}

#[derive(Debug, Clone)]
struct SseEvent {
    name: String,
    data: Value,
}

/// Reads the whole SSE stream until `done` (or the connection closes) and
/// returns the parsed events.
async fn read_events(response: reqwest::Response) -> Vec<SseEvent> {
    let mut events = Vec::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.expect("chunk");
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find("\n\n") {
            let block = buffer[..end].to_string();
            buffer.drain(..end + 2);
            let mut name = String::new();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    name = value.trim().to_string();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push_str(value.trim_start());
                }
            }
            if name.is_empty() {
                continue;
            }
            let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
            let is_done = name == "done";
            events.push(SseEvent { name, data });
            if is_done {
                return events;
            }
        }
    }
    events
}

async fn wait_for_status(server: &TestServer, id: &str, wanted: &str) -> Value {
    for _ in 0..200 {
        let job: Value = server
            .get(&format!("/api/v1/jobs/{id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if job["status"] == wanted {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("job {id} never reached {wanted}");
}

#[tokio::test]
async fn info_and_auth() {
    let server = TestServer::start().await;

    let anonymous: Value = server
        .client
        .get(server.url("/api/v1/info"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(anonymous["service"], "neurodesk-compute");
    assert_eq!(anonymous["protocol"], 1);
    assert_eq!(anonymous["auth"], "bearer");
    assert!(anonymous.get("tools").is_none());

    let response = server.get("/api/v1/info").send().await.unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let info: Value = response.json().await.unwrap();
    assert_eq!(info["simulated"], true);
    assert_eq!(info["runner"], "simulate");
    assert_eq!(info["tools"][0]["id"], "nesvor");
    assert_eq!(info["tools"][0]["commands"][0], "reconstruct");
    assert_eq!(info["limits"]["maxFiles"], 40);
    assert_eq!(info["gpu"]["available"], false);

    let probe: Value = server
        .client
        .get(server.url("/api/v1/info"))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(probe.get("tools").is_none());

    let response = server
        .client
        .get(server.url("/api/v1/jobs/none"))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["vary"], "Origin");
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    assert!(body["error"]["message"].is_string());

    let response = server
        .client
        .get(server.url("/api/v1/jobs/none"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = server.get("/api/v1/jobs/none").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "not-found");

    server.stop().await;
}

#[tokio::test]
async fn cors_preflight() {
    let server = TestServer::start().await;

    let response = server
        .client
        .request(reqwest::Method::OPTIONS, server.url("/api/v1/jobs"))
        .header("Origin", "https://webapps.neurodesk.org")
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Private-Network", "true")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let headers = response.headers();
    assert_eq!(
        headers["access-control-allow-origin"],
        "https://webapps.neurodesk.org"
    );
    assert_eq!(
        headers["access-control-allow-headers"],
        "Authorization, Content-Type"
    );
    assert_eq!(
        headers["access-control-allow-methods"],
        "GET, POST, DELETE, OPTIONS"
    );
    assert_eq!(headers["access-control-allow-private-network"], "true");
    assert_eq!(headers["access-control-max-age"], "600");
    assert_eq!(headers["vary"], "Origin");

    let response = server
        .client
        .request(reqwest::Method::OPTIONS, server.url("/api/v1/jobs"))
        .header("Origin", "https://evil.example")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());
    assert!(response
        .headers()
        .get("access-control-allow-private-network")
        .is_none());

    let response = server
        .get("/api/v1/info")
        .header("Origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:5173"
    );

    let response = server
        .get("/api/v1/info")
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());

    server.stop().await;
}

#[tokio::test]
async fn full_job_lifecycle() {
    let server = TestServer::start().await;

    let response = server
        .post_job(
            &spec(2, 3000),
            &[("stack-0", nifti_gz(1.0)), ("stack-1", nifti_gz(3.0))],
        )
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = response.json().await.unwrap();
    let id = accepted["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 32);
    assert_eq!(accepted["status"], "queued");
    assert_eq!(accepted["position"], 0);

    let response = server
        .client
        .get(server.url(&format!("/api/v1/jobs/{id}/events?token={TOKEN}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let events = read_events(response).await;
    assert_eq!(
        events.first().map(|event| event.name.as_str()),
        Some("status")
    );
    assert_eq!(events.last().map(|event| event.name.as_str()), Some("done"));
    let first_progress = events
        .iter()
        .position(|event| event.name == "progress")
        .expect("progress");
    let first_log = events
        .iter()
        .position(|event| event.name == "log")
        .expect("log");
    let done_index = events.len() - 1;
    assert!(first_progress < done_index);
    assert!(first_log < done_index);
    let stages: Vec<String> = events
        .iter()
        .filter(|event| event.name == "progress")
        .map(|event| event.data["stage"].as_str().unwrap().to_string())
        .collect();
    assert!(stages.contains(&"Loading stacks".to_string()), "{stages:?}");
    assert!(stages.contains(&"Reconstruction".to_string()), "{stages:?}");
    assert!(stages.contains(&"Finished".to_string()), "{stages:?}");
    let fractions: Vec<f64> = events
        .iter()
        .filter(|event| event.name == "progress")
        .map(|event| event.data["fraction"].as_f64().unwrap())
        .collect();
    assert!(
        fractions
            .iter()
            .any(|fraction| *fraction > 0.4 && *fraction < 0.9),
        "{fractions:?}"
    );
    let log_levels: Vec<&str> = events
        .iter()
        .filter(|event| event.name == "log")
        .map(|event| event.data["level"].as_str().unwrap())
        .collect();
    assert!(log_levels
        .iter()
        .all(|level| ["info", "warning", "error"].contains(level)));
    let done = &events[done_index].data;
    assert_eq!(done["status"], "succeeded");
    assert_eq!(done["simulated"], true);
    assert_eq!(done["progress"], 1.0);
    assert!(done["startedAt"].is_string());
    assert!(done["finishedAt"].is_string());
    assert!(done["error"].is_null());
    let names: Vec<&str> = done["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|output| output["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["volume.nii.gz", "result.json", "log.txt"]);

    let job: Value = server
        .get(&format!("/api/v1/jobs/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(job["status"], "succeeded");
    assert_eq!(job["tool"], "nesvor");
    assert_eq!(job["command"], "reconstruct");
    assert_eq!(job["outputs"][1]["contentType"], "application/json");
    assert!(job["createdAt"].as_str().unwrap().ends_with('Z'));

    let response = server
        .get(&format!("/api/v1/jobs/{id}/outputs/volume.nii.gz"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/gzip");
    assert_eq!(
        response.headers()["content-disposition"],
        "attachment; filename=\"volume.nii.gz\""
    );
    let length: u64 = response.headers()["content-length"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    let bytes = response.bytes().await.unwrap();
    assert_eq!(bytes.len() as u64, length);
    let mut decoded = Vec::new();
    GzDecoder::new(&bytes[..])
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(&decoded[344..348], b"n+1\0");
    assert_eq!(i16::from_le_bytes([decoded[70], decoded[71]]), 16);
    assert_eq!(decoded.len(), 352 + 64 * 4);
    for voxel in decoded[352..].as_chunks::<4>().0 {
        assert_eq!(f32::from_le_bytes(*voxel), 2.0);
    }

    let response = server
        .client
        .get(server.url(&format!(
            "/api/v1/jobs/{id}/outputs/result.json?token={TOKEN}"
        )))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value = response.json().await.unwrap();
    assert_eq!(result["simulated"], true);
    assert_eq!(result["stacks"], 2);
    assert_eq!(result["options"]["iterations"], 3000);

    let log = server
        .get(&format!("/api/v1/jobs/{id}/outputs/log.txt"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(log.contains(
        "argv: nesvor reconstruct --input-stacks /job/in/stack-0.nii.gz /job/in/stack-1.nii.gz"
    ));
    assert!(log.contains("NeSVoR training starts."));

    let response = server
        .get(&format!("/api/v1/jobs/{id}/outputs/../../token"))
        .send()
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);

    let response = server
        .client
        .delete(server.url(&format!("/api/v1/jobs/{id}")))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = server
        .get(&format!("/api/v1/jobs/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = server
        .client
        .delete(server.url(&format!("/api/v1/jobs/{id}")))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    server.stop().await;
}

#[tokio::test]
async fn cancel_running_job() {
    let server = TestServer::start().await;

    let response = server
        .post_job(&spec(1, 20000), &[("stack-0", nifti_gz(5.0))])
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = response.json().await.unwrap();
    let id = accepted["id"].as_str().unwrap().to_string();

    wait_for_status(&server, &id, "running").await;
    let stream = server
        .get(&format!("/api/v1/jobs/{id}/events"))
        .send()
        .await
        .unwrap();
    let reader = tokio::spawn(read_events(stream));

    tokio::time::sleep(Duration::from_millis(120)).await;
    let response = server
        .client
        .delete(server.url(&format!("/api/v1/jobs/{id}")))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let events = tokio::time::timeout(Duration::from_secs(10), reader)
        .await
        .expect("stream closes")
        .unwrap();
    let done = events.last().expect("done event");
    assert_eq!(done.name, "done");
    assert_eq!(done.data["status"], "cancelled");
    assert!(events
        .iter()
        .any(|event| event.name == "status" && event.data["status"] == "cancelled"));
    let response = server
        .get(&format!("/api/v1/jobs/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    server.stop().await;
}

#[tokio::test]
async fn queue_positions() {
    let server = TestServer::start().await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let response = server
            .post_job(&spec(1, 5000), &[("stack-0", nifti_gz(1.0))])
            .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: Value = response.json().await.unwrap();
        ids.push(accepted["id"].as_str().unwrap().to_string());
    }
    let third: Value = server
        .get(&format!("/api/v1/jobs/{}", ids[2]))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(third["status"], "queued");
    assert!(third["position"].as_u64().unwrap() >= 1);
    assert!(third["progress"].is_null());
    for id in &ids {
        let job = wait_for_status(&server, id, "succeeded").await;
        assert_eq!(job["position"], 0);
    }
    server.stop().await;
}

#[tokio::test]
async fn invalid_specs() {
    let server = TestServer::start().await;

    let mut bad = spec(1, 3000);
    bad["options"]["nIter"] = json!(5);
    let response = server.post_job(&bad, &[("stack-0", nifti_gz(1.0))]).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid-spec");
    assert!(body["error"]["message"].as_str().unwrap().contains("nIter"));

    let response = server
        .post_job(&spec(2, 3000), &[("stack-0", nifti_gz(1.0))])
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = server
        .post_job(&spec(1, 3000), &[("stack-0", b"not a nifti".to_vec())])
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().contains("NIfTI"));

    let response = server
        .post_job(&spec(1, 3000), &[("stack-0", nifti_plain(1.0))])
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let accepted: Value = response.json().await.unwrap();
    wait_for_status(&server, accepted["id"].as_str().unwrap(), "succeeded").await;

    let response = server
        .client
        .post(server.url("/api/v1/jobs"))
        .bearer_auth(TOKEN)
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let form = Form::new().part("stack-0", Part::bytes(nifti_gz(1.0)));
    let response = server
        .client
        .post(server.url("/api/v1/jobs"))
        .bearer_auth(TOKEN)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    assert!(
        std::fs::read_dir(server._data_dir.path().join("jobs"))
            .unwrap()
            .count()
            <= 1
    );
    server.stop().await;
}

#[tokio::test]
async fn upload_limits() {
    let server = TestServer::start_with(|config| {
        config.max_upload_bytes = 2048;
        config.max_files = 2;
    })
    .await;

    let big = vec![0u8; 4096];
    let response = server.post_job(&spec(1, 3000), &[("stack-0", big)]).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "too-large");

    let response = server
        .post_job(
            &spec(3, 3000),
            &[
                ("stack-0", nifti_plain(1.0)[..100].to_vec()),
                ("stack-1", nifti_plain(1.0)[..100].to_vec()),
                ("stack-2", nifti_plain(1.0)[..100].to_vec()),
            ],
        )
        .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

    server.stop().await;
}

#[tokio::test]
async fn static_www() {
    let www = tempfile::tempdir().unwrap();
    std::fs::write(www.path().join("index.html"), "<html>hello</html>").unwrap();
    let server = TestServer::start_with(|config| {
        config.www = Some(www.path().to_path_buf());
    })
    .await;
    let response = server.client.get(server.url("/")).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["cross-origin-opener-policy"],
        "same-origin"
    );
    assert_eq!(
        response.headers()["cross-origin-embedder-policy"],
        "credentialless"
    );
    assert_eq!(response.text().await.unwrap(), "<html>hello</html>");
    let response = server
        .client
        .get(server.url("/api/v1/nothing"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    server.stop().await;
}
