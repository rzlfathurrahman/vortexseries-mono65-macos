use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tower_http::cors::CorsLayer;

const VID: u16 = 0x1a2c;
const PID: u16 = 0x6180;
const USAGE_PAGE: u16 = 0xff00;
const PORT: u16 = 7878;

const INDEX_HTML: &str = include_str!("../index.html");
const KB_PNG: &[u8] = include_bytes!("../kb_102.png");

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Config {
    #[serde(rename = "osMode")]
    os_mode: String,
}

#[derive(Clone)]
struct AppState {
    device: Arc<Mutex<Option<HidDevice>>>,
    active_remaps: Arc<Mutex<Vec<(String, String)>>>,
    config: Arc<Mutex<Config>>,
}

fn open_device() -> Result<HidDevice, String> {
    let api = HidApi::new().map_err(|e| format!("HID init error: {}", e))?;
    for device_info in api.device_list() {
        if device_info.vendor_id() == VID
            && device_info.product_id() == PID
            && device_info.usage_page() == USAGE_PAGE
        {
            return device_info
                .open_device(&api)
                .map_err(|e| format!("Failed to open HID device: {}", e));
        }
    }
    Err("MONO 65 device not found (lane ff00)".to_string())
}

fn mk_frame(id: u8, payload: &[u8]) -> [u8; 64] {
    let mut buf = [0u8; 64];
    buf[0] = id;
    let len = payload.len().min(63);
    buf[1..1 + len].copy_from_slice(&payload[..len]);
    buf
}

fn send_preset(dev: &HidDevice, mode: u8, speed: u8, brightness: u8) -> Result<(), String> {
    let mode_arg = mode.saturating_sub(1);
    let frame = mk_frame(0x07, &[0xff, 0xff, mode_arg, speed, brightness, 0x00, 0x00]);
    dev.send_feature_report(&frame)
        .map_err(|e| format!("Send preset failed: {}", e))?;
    Ok(())
}

fn send_remap(dev: &HidDevice, pairs: &[(u8, u8)]) -> Result<(), String> {
    if pairs.len() > 12 {
        return Err("Max 12 remap pairs supported".to_string());
    }

    // 1. Macro relay: open + 16 empty rows + commit
    let _ = dev.send_feature_report(&mk_frame(0x07, &[0x01, 0x23, 0x45, 0x67, 0x00]));
    thread::sleep(Duration::from_millis(250));

    for _ in 0..16 {
        let mut r = [0u8; 64];
        r[0] = 0x07;
        for s in 0..8 {
            r[s * 8] = 0x07;
            r[s * 8 + 1] = 0x88;
        }
        let _ = dev.send_feature_report(&r);
        thread::sleep(Duration::from_millis(150));
    }
    thread::sleep(Duration::from_millis(250));

    let _ = dev.send_feature_report(&mk_frame(0x07, &[0xab, 0xcd, 0xef, 0x00]));
    thread::sleep(Duration::from_millis(250));

    // 2. Remap mode open
    let _ = dev.send_feature_report(&mk_frame(0x07, &[0x76, 0x54, 0x32, 0x10, 0x00]));
    thread::sleep(Duration::from_millis(250));

    // 3. Staging rows
    let mut p = [0u8; 64];
    p[0] = 0x07;
    for row in 0..8 {
        p[row * 8] = 0x07;
        p[row * 8 + 1] = 0x99;
    }

    let stg_f = |s: usize| -> usize {
        if s < 6 {
            2 + s
        } else if s < 12 {
            4 + s
        } else if s < 18 {
            6 + s
        } else {
            8 + s
        }
    };

    for (i, &(src, dst)) in pairs.iter().enumerate() {
        p[stg_f(i)] = src;
        p[stg_f(12 + i)] = dst;
    }

    let _ = dev.send_feature_report(&p);
    thread::sleep(Duration::from_millis(250));

    // 4. Commit
    let _ = dev.send_feature_report(&mk_frame(0x07, &[0xfe, 0xdc, 0xba, 0x00]));
    thread::sleep(Duration::from_millis(250));

    Ok(())
}

// Handlers
async fn handle_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn handle_kb_png() -> Response {
    (
        [(header::CONTENT_TYPE, "image/png")],
        KB_PNG,
    )
        .into_response()
}

#[derive(Serialize)]
struct PingResponse {
    connected: bool,
}

async fn handle_ping() -> Json<PingResponse> {
    Json(PingResponse { connected: true })
}

#[derive(Deserialize)]
struct PresetRequest {
    mode: u8,
    speed: u8,
    bri: u8,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    err: Option<String>,
}

async fn handle_preset(
    State(state): State<AppState>,
    Json(req): Json<PresetRequest>,
) -> (StatusCode, Json<ApiResponse>) {
    let mut dev_lock = state.device.lock().unwrap();
    if dev_lock.is_none() {
        match open_device() {
            Ok(d) => *dev_lock = Some(d),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse {
                        ok: false,
                        msg: String::new(),
                        err: Some(e),
                    }),
                )
            }
        }
    }

    if let Some(ref dev) = *dev_lock {
        if let Err(e) = send_preset(dev, req.mode, req.speed, req.bri) {
            *dev_lock = None;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    ok: false,
                    msg: String::new(),
                    err: Some(e),
                }),
            );
        }
    }

    let msg = if req.bri == 0 {
        "Backlight turned off".to_string()
    } else {
        format!(
            "Preset mode {} applied (speed {}, brightness {})",
            req.mode, req.speed, req.bri
        )
    };

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            msg,
            err: None,
        }),
    )
}

#[derive(Deserialize)]
struct SyncRemapsRequest {
    pairs: Vec<(String, String)>,
}

async fn handle_sync_remaps(
    State(state): State<AppState>,
    Json(req): Json<SyncRemapsRequest>,
) -> (StatusCode, Json<ApiResponse>) {
    let mut parsed = Vec::new();
    for (s, d) in &req.pairs {
        let src_u = u8::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0);
        let dst_u = u8::from_str_radix(d.trim_start_matches("0x"), 16).unwrap_or(0);
        parsed.push((src_u, dst_u));
    }

    let mut dev_lock = state.device.lock().unwrap();
    if dev_lock.is_none() {
        match open_device() {
            Ok(d) => *dev_lock = Some(d),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse {
                        ok: false,
                        msg: String::new(),
                        err: Some(e),
                    }),
                )
            }
        }
    }

    if let Some(ref dev) = *dev_lock {
        if let Err(e) = send_remap(dev, &parsed) {
            *dev_lock = None;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    ok: false,
                    msg: String::new(),
                    err: Some(e),
                }),
            );
        }
    }

    {
        let mut remaps = state.active_remaps.lock().unwrap();
        *remaps = req.pairs.clone();
        let _ = fs::write("active_remaps.json", serde_json::to_string_pretty(&*remaps).unwrap());
    }

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            msg: format!("Successfully synced {} remaps to hardware!", req.pairs.len()),
            err: None,
        }),
    )
}

#[derive(Deserialize)]
struct SetOSModeRequest {
    mode: String,
}

#[derive(Serialize)]
struct SetOSModeResponse {
    ok: bool,
    msg: String,
    #[serde(rename = "activeRemaps")]
    active_remaps: Vec<(String, String)>,
}

async fn handle_set_os_mode(
    State(state): State<AppState>,
    Json(req): Json<SetOSModeRequest>,
) -> (StatusCode, Json<SetOSModeResponse>) {
    let target_mode = if req.mode == "win" { "win" } else { "mac" };

    let mut remaps = state.active_remaps.lock().unwrap();
    remaps.retain(|p| p.0 != "0xe3" && p.0 != "0xe2");

    if target_mode == "mac" {
        remaps.push(("0xe3".to_string(), "0xe2".to_string()));
        remaps.push(("0xe2".to_string(), "0xe3".to_string()));
    }

    let mut parsed = Vec::new();
    for (s, d) in remaps.iter() {
        let src_u = u8::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0);
        let dst_u = u8::from_str_radix(d.trim_start_matches("0x"), 16).unwrap_or(0);
        parsed.push((src_u, dst_u));
    }

    let mut dev_lock = state.device.lock().unwrap();
    if dev_lock.is_none() {
        if let Ok(d) = open_device() {
            *dev_lock = Some(d);
        }
    }

    if let Some(ref dev) = *dev_lock {
        let _ = send_remap(dev, &parsed);
    }

    let _ = fs::write("active_remaps.json", serde_json::to_string_pretty(&*remaps).unwrap());
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.os_mode = target_mode.to_string();
        let _ = fs::write("config.json", serde_json::to_string_pretty(&*cfg).unwrap());
    }

    (
        StatusCode::OK,
        Json(SetOSModeResponse {
            ok: true,
            msg: format!("Switched to {} mode", target_mode.to_uppercase()),
            active_remaps: remaps.clone(),
        }),
    )
}

#[tokio::main]
async fn main() {
    let mut initial_remaps = Vec::new();
    if Path::new("active_remaps.json").exists() {
        if let Ok(data) = fs::read_to_string("active_remaps.json") {
            if let Ok(r) = serde_json::from_str::<Vec<(String, String)>>(&data) {
                initial_remaps = r;
            }
        }
    }

    let mut initial_config = Config {
        os_mode: "mac".to_string(),
    };
    if Path::new("config.json").exists() {
        if let Ok(data) = fs::read_to_string("config.json") {
            if let Ok(c) = serde_json::from_str::<Config>(&data) {
                initial_config = c;
            }
        }
    }

    let initial_dev = open_device().ok();

    let state = AppState {
        device: Arc::new(Mutex::new(initial_dev)),
        active_remaps: Arc::new(Mutex::new(initial_remaps)),
        config: Arc::new(Mutex::new(initial_config)),
    };

    let app = Router::new()
        .route("/", get(handle_index))
        .route("/kb_102.png", get(handle_kb_png))
        .route("/api/ping", get(handle_ping))
        .route("/api/preset", post(handle_preset))
        .route("/api/sync-remaps", post(handle_sync_remaps))
        .route("/api/set-os-mode", post(handle_set_os_mode))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", PORT))
        .await
        .unwrap();

    println!("⚡ MONO 65 Rust Native Controller running on: http://127.0.0.1:{}", PORT);
    axum::serve(listener, app).await.unwrap();
}
