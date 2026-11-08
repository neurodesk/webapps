//! An in-process single-owner server with the fake project tool, for tests.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use crate::config::ServeConfig;
use crate::server::{self, Running};
use crate::tools::Tool;

/// The pairing code of test servers.
pub const CODE: &str = "test-code";

/// A running server, its data directory and a paired client.
pub struct Harness {
    pub running: Option<Running>,
    pub config: ServeConfig,
    pub token: String,
    pub data_dir: tempfile::TempDir,
    pub client: reqwest::Client,
}

/// The fake project tool and the file tools.
pub fn tools() -> Vec<Arc<dyn Tool>> {
    let mut tools = crate::tools::registry();
    tools.push(Arc::new(crate::tools::fake::FakeRelion));
    tools
}

impl Harness {
    /// A simulated single-owner server, adjusted by `configure`.
    pub async fn start(configure: impl FnOnce(&mut ServeConfig, &Path)) -> Harness {
        let data_dir = tempfile::tempdir().expect("temp dir");
        let mut config = ServeConfig::simulated(data_dir.path().join("data"), CODE);
        config.single_owner = true;
        configure(&mut config, data_dir.path());
        let mut harness = Harness {
            running: None,
            config,
            token: String::new(),
            data_dir,
            client: reqwest::Client::new(),
        };
        harness.boot().await.expect("server starts");
        harness.token = harness.pair().await;
        harness
    }

    /// Starts the server on the harness's configuration. Another test's
    /// forked child can hold a copy of the previous server's `flock` until it
    /// execs, so a busy lock is retried briefly.
    pub async fn boot(&mut self) -> std::io::Result<()> {
        let mut attempts = 0;
        loop {
            let config = self.config.clone();
            let tools = crate::tools::available(&config, tools());
            match server::start_with_tools(config, tools).await {
                Ok(running) => {
                    self.running = Some(running);
                    return Ok(());
                }
                Err(error) if error.to_string().contains("already in use") && attempts < 40 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Stops the server, keeping its data directory.
    pub async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.shutdown().await;
        }
    }

    /// Stops and starts the server; the credential stays valid.
    pub async fn restart(&mut self) {
        self.stop().await;
        self.boot().await.expect("server restarts");
    }

    /// The data directory of the server.
    pub fn data(&self) -> PathBuf {
        self.config.data_dir.clone()
    }

    /// A URL of the running server.
    pub fn url(&self, path: &str) -> String {
        let running = self.running.as_ref().expect("server is running");
        format!("{}{path}", running.base_url("http"))
    }

    /// Pairs and returns a new credential.
    pub async fn pair(&self) -> String {
        let paired: Value = self
            .client
            .post(self.url("/api/v1/pair"))
            .json(&json!({ "code": CODE }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        paired["token"].as_str().unwrap().to_string()
    }

    /// An authenticated GET.
    pub async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
    }

    /// An authenticated GET returning JSON.
    pub async fn json(&self, path: &str) -> Value {
        self.get(path).await.json().await.unwrap()
    }

    /// An authenticated DELETE.
    pub async fn delete(&self, path: &str) -> reqwest::Response {
        self.client
            .delete(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
    }

    /// An authenticated POST without a body.
    pub async fn post(&self, path: &str) -> reqwest::Response {
        self.client
            .post(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap()
    }

    /// Creates a project and returns its id.
    pub async fn project(&self, name: &str) -> String {
        let response = self
            .client
            .post(self.url("/api/v1/projects"))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::CREATED);
        let project: Value = response.json().await.unwrap();
        project["id"].as_str().unwrap().to_string()
    }

    /// Submits a job with file parts.
    pub async fn submit(&self, spec: &Value, files: &[(&str, Vec<u8>)]) -> reqwest::Response {
        let mut form = Form::new().part(
            "spec",
            Part::text(spec.to_string())
                .mime_str("application/json")
                .unwrap(),
        );
        for (name, bytes) in files {
            form = form.part(
                name.to_string(),
                Part::bytes(bytes.clone()).file_name("upload"),
            );
        }
        self.client
            .post(self.url("/api/v1/jobs"))
            .bearer_auth(&self.token)
            .header("Idempotency-Key", crate::api::new_job_id())
            .multipart(form)
            .send()
            .await
            .unwrap()
    }

    /// Submits a job that must be accepted; returns its id.
    pub async fn accepted(&self, spec: &Value) -> String {
        let response = self.submit(spec, &[]).await;
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert_eq!(status, reqwest::StatusCode::ACCEPTED, "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    /// Polls a job until its status is `wanted`.
    pub async fn wait_status(&self, id: &str, wanted: &str) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let job = self.json(&format!("/api/v1/jobs/{id}")).await;
            if job["status"] == wanted {
                return job;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "job {id} never reached {wanted}: {job}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// A minimal MRC file: a 1024-byte header with `MAP ` at byte 208.
pub fn mrc() -> Vec<u8> {
    let mut bytes = vec![0u8; 1100];
    bytes[208..212].copy_from_slice(b"MAP ");
    bytes
}
