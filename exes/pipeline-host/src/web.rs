//! Browser host: a JavaScript object owns the files and dispatches each tool step to its worker driver.

use crate::{Exit, Host, Stat, Step};
use js_sys::{Array, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    pub type JsHost;
    /// `run(argv, fslOut, gpu, env)`: `fslOut` is the step's FSLOUTPUTTYPE (fastprep's drivers read it); `env` is the
    /// step's whole environment as `[key, value]` pairs.
    #[wasm_bindgen(method, catch)]
    fn run(
        this: &JsHost,
        argv: Array,
        fsl_out: Option<String>,
        gpu: bool,
        env: Array,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readRange)]
    fn read_range(this: &JsHost, path: &str, offset: f64, len: u32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readText)]
    fn read_text(this: &JsHost, path: &str, limit: u32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn write(this: &JsHost, path: &str, bytes: &[u8]) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn append(this: &JsHost, path: &str, bytes: &[u8]) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method)]
    fn exists(this: &JsHost, path: &str) -> bool;
    /// `null` or `[size, mtime]`
    #[wasm_bindgen(method)]
    fn stat(this: &JsHost, path: &str) -> JsValue;
    #[wasm_bindgen(method)]
    fn list(this: &JsHost, dir: &str) -> Array;
    #[wasm_bindgen(method, catch)]
    fn mkdirs(this: &JsHost, dir: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method)]
    fn remove(this: &JsHost, path: &str);
    #[wasm_bindgen(method, catch)]
    fn rename(this: &JsHost, from: &str, to: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method, catch)]
    fn copy(this: &JsHost, from: &str, to: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method)]
    fn now(this: &JsHost) -> f64;
    #[wasm_bindgen(method, js_name = localTime)]
    fn local_time(this: &JsHost) -> String;
    #[wasm_bindgen(method)]
    fn log(this: &JsHost, line: &str);
}

pub fn message(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            Reflect::get(&e, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
        })
        .unwrap_or_else(|| format!("{e:?}"))
}

async fn wait(p: Result<Promise, JsValue>) -> Result<JsValue, String> {
    JsFuture::from(p.map_err(message)?).await.map_err(message)
}

pub struct Web(pub JsHost);

impl Host for Web {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        let argv: Array = step.argv.iter().map(|a| JsValue::from_str(a)).collect();
        let env: Array = step
            .env
            .iter()
            .map(|(k, v)| JsValue::from(Array::of2(&k.into(), &v.into())))
            .collect();
        let fsl_out = step.env_var("FSLOUTPUTTYPE").map(String::from);
        let r = wait(self.0.run(argv, fsl_out, step.gpu, env)).await?;
        let field = |k: &str| Reflect::get(&r, &k.into()).unwrap_or(JsValue::UNDEFINED);
        Ok(Exit {
            code: field("code").as_f64().unwrap_or(1.0) as i32,
            stdout: field("stdout").as_string().unwrap_or_default(),
            stderr: field("stderr").as_string().unwrap_or_default(),
        })
    }
    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        Ok(
            Uint8Array::new(&wait(self.0.read_range(path, offset as f64, len as u32)).await?)
                .to_vec(),
        )
    }
    async fn read_text(&self, path: &str, limit: usize) -> Result<String, String> {
        wait(self.0.read_text(path, limit as u32))
            .await?
            .as_string()
            .ok_or_else(|| format!("{path}: not text"))
    }
    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        wait(self.0.write(path, bytes)).await.map(|_| ())
    }
    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        wait(self.0.append(path, bytes)).await.map(|_| ())
    }
    fn exists(&self, path: &str) -> bool {
        self.0.exists(path)
    }
    fn stat(&self, path: &str) -> Option<Stat> {
        let v = self.0.stat(path);
        let a: &Array = v.dyn_ref()?;
        Some((a.get(0).as_f64()? as u64, a.get(1).as_f64()? as u128))
    }
    fn list(&self, dir: &str) -> Vec<String> {
        self.0
            .list(dir)
            .iter()
            .filter_map(|v| v.as_string())
            .collect()
    }
    fn mkdirs(&self, dir: &str) -> Result<(), String> {
        self.0.mkdirs(dir).map_err(message)
    }
    fn remove(&self, path: &str) {
        self.0.remove(path)
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.0.rename(from, to).map_err(message)
    }
    fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        self.0.copy(from, to).map_err(message)
    }
    fn now(&self) -> f64 {
        self.0.now()
    }
    fn local_time(&self) -> String {
        self.0.local_time()
    }
    fn log(&self, line: &str) {
        self.0.log(line)
    }
}
