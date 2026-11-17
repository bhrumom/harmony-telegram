//! Headless Linux CLI Verification Runner (`telegram_ohos_cli`), backing `scripts/ohos-app-cli`.
//! Executes the exact same `TelegramCoreEngine` & `OhosUiController` compiled into `libtelegram_core.so`.

use std::env;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use telegram_core::ui_head::run_ui_session;
use telegram_core::{EngineInitConfig, TelegramCoreEngine, ALL_28_DOMAINS};

fn print_json(val: &Value) {
    println!("{}", serde_json::to_string(val).unwrap_or_else(|_| "{}".into()));
}

fn repo_root() -> PathBuf {
    if let Ok(manifest_dir) = env::var("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest_dir);
        if let Some(root) = p.parent().and_then(|c| c.parent()) {
            return root.to_path_buf();
        }
    }
    if let Ok(exe) = env::current_exe() {
        // target/release/telegram_ohos_cli -> repo root
        if let Some(root) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            if root.join("Cargo.toml").is_file() {
                return root.to_path_buf();
            }
        }
    }
    PathBuf::from("/home/antigravity/harmony-telegram")
}

fn make_init_cfg(sandbox: &Path, server_url: &str) -> EngineInitConfig {
    EngineInitConfig {
        server_url: server_url.to_string(),
        files_dir: sandbox.join("files").to_string_lossy().to_string(),
        cache_dir: sandbox.join("cache").to_string_lossy().to_string(),
        temp_dir: sandbox.join("temp").to_string_lossy().to_string(),
        database_dir: sandbox.join("database").to_string_lossy().to_string(),
        resource_dir: sandbox.join("resources").to_string_lossy().to_string(),
        ca_cert_path: "/etc/ssl/certs/cacert.pem".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        device_model: "HarmonyOS NEXT Headless Verification Device".to_string(),
        os_full_name: "OpenHarmony 6.0 API 20".to_string(),
        locale: "zh-CN".to_string(),
    }
}

fn find_server_binary(root: &Path) -> Option<PathBuf> {
    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("target"));
    let release_bin = target_dir.join("release").join("gpui_telegram_server");
    if release_bin.is_file() {
        return Some(release_bin);
    }
    let debug_bin = target_dir.join("debug").join("gpui_telegram_server");
    if debug_bin.is_file() {
        return Some(debug_bin);
    }
    None
}

fn check_elf_magic_and_arch(path: &Path) -> Result<(String, Vec<String>, bool), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed reading {}: {e}", path.display()))?;
    if bytes.len() < 64 || &bytes[0..4] != b"\x7fELF" {
        return Err(format!("{} is not a valid 64-bit ELF binary", path.display()));
    }
    let e_machine = u16::from_le_bytes([bytes[18], bytes[19]]);
    let arch = match e_machine {
        0xB7 => "aarch64",
        0x3E => "x86_64",
        other => return Err(format!("Unexpected ELF e_machine 0x{other:x}")),
    };

    // Inspect NEEDED libraries & N-API registration via llvm-readelf if available
    let readelf = env::var("OHOS_SDK_NATIVE")
        .map(|p| PathBuf::from(p).join("llvm/bin/llvm-readelf"))
        .unwrap_or_else(|_| {
            PathBuf::from("/home/antigravity/toolchains/ohos-sdk/linux/20/native/llvm/bin/llvm-readelf")
        });
    let mut needed = Vec::new();
    let mut has_napi_reg = false;
    if readelf.is_file() {
        if let Ok(out) = Command::new(&readelf).arg("-d").arg(path).output() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.contains("(NEEDED)") {
                    if let Some(start) = line.find('[') {
                        if let Some(end) = line[start + 1..].find(']') {
                            needed.push(line[start + 1..start + 1 + end].to_string());
                        }
                    }
                }
            }
        }
        if let Ok(out) = Command::new(&readelf).arg("-Ws").arg(path).output() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            has_napi_reg = stdout.contains("napi_module_register")
                || stdout.contains("napi_register_module");
        }
    } else {
        let raw_lossy = String::from_utf8_lossy(&bytes);
        if raw_lossy.contains("libace_napi.z.so") {
            needed.push("libace_napi.z.so".to_string());
        }
        has_napi_reg = raw_lossy.contains("napi_module_register");
    }
    Ok((arch.to_string(), needed, has_napi_reg))
}

fn inspect_zip_entries(path: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("unzip")
        .arg("-Z1")
        .arg(path)
        .output()
        .map_err(|e| format!("Failed invoking unzip on {}: {e}", path.display()))?;
    if !out.status.success() {
        return Err(format!("Invalid zip archive {}", path.display()));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_json(&json!({
            "ok": false,
            "data": null,
            "error": {
                "code": "USAGE_ERROR",
                "message": "Subcommands: server-start | server-stop | invoke | ui-session | inspect-artifacts | domains | waveform-test | vad-test"
            }
        }));
        return ExitCode::from(2);
    }

    let sub = args[0].as_str();
    match sub {
        "domains" => {
            print_json(&json!({
                "ok": true,
                "data": {
                    "count": ALL_28_DOMAINS.len(),
                    "domains": ALL_28_DOMAINS
                },
                "error": null
            }));
            ExitCode::SUCCESS
        }
        "server-start" => {
            let mut port: u16 = 18080;
            let mut data_dir = String::new();
            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--port" if i + 1 < args.len() => {
                        port = args[i + 1].parse().unwrap_or(18080);
                        i += 2;
                    }
                    "--data-dir" | "--sandbox" if i + 1 < args.len() => {
                        data_dir = args[i + 1].clone();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            if data_dir.trim().is_empty() {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": "USAGE_ERROR", "message": "server-start requires --data-dir <dir> [--port <port>]" }
                }));
                return ExitCode::from(2);
            }
            let data_path = PathBuf::from(&data_dir);
            let media_dir = data_path.join("media");
            let tmp_dir = data_path.join("tmp");
            if let Err(e) = fs::create_dir_all(&media_dir).and_then(|_| fs::create_dir_all(&tmp_dir)) {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": "IO_ERROR", "message": format!("Failed creating data-dir: {e}") }
                }));
                return ExitCode::from(1);
            }

            let root = repo_root();
            let Some(server_bin) = find_server_binary(&root) else {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": "BINARY_NOT_FOUND", "message": "gpui_telegram_server binary not found under target/" }
                }));
                return ExitCode::from(1);
            };

            let log_path = data_path.join("server.log");
            let log_file = match File::create(&log_path) {
                Ok(f) => f,
                Err(e) => {
                    print_json(&json!({
                        "ok": false,
                        "data": null,
                        "error": { "code": "IO_ERROR", "message": format!("Failed creating server.log: {e}") }
                    }));
                    return ExitCode::from(1);
                }
            };
            let err_file = match log_file.try_clone() {
                Ok(f) => f,
                Err(e) => {
                    print_json(&json!({
                        "ok": false,
                        "data": null,
                        "error": { "code": "IO_ERROR", "message": format!("Failed cloning server.log fd: {e}") }
                    }));
                    return ExitCode::from(1);
                }
            };

            let db_url = format!("sqlite://{}", data_path.join("gpui_telegram.db").display());
            let child = match Command::new(&server_bin)
                .current_dir(&data_path)
                .env("HOST", "127.0.0.1")
                .env("PORT", port.to_string())
                .env("DATABASE_URL", &db_url)
                .env("MEDIA_STORAGE_PATH", &media_dir)
                .env("TMPDIR", &tmp_dir)
                .env("GPUI_OFFLINE_TEST", "1")
                .env("HERMES_ENABLE_PUBLIC_CLOUD_FALLBACK", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(err_file))
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    print_json(&json!({
                        "ok": false,
                        "data": null,
                        "error": { "code": "SPAWN_ERROR", "message": format!("Failed spawning server: {e}") }
                    }));
                    return ExitCode::from(1);
                }
            };

            let pid = child.id();
            let _ = fs::write(data_path.join("server.pid"), pid.to_string());
            let server_url = format!("http://127.0.0.1:{port}");
            let status_url = format!("{server_url}/api/v1/status");

            let deadline = Instant::now() + Duration::from_secs(15);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio current_thread");
            let http = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
                .expect("reqwest client");
            let mut ready = false;
            while Instant::now() < deadline {
                let ok = rt.block_on(async {
                    http.get(&status_url)
                        .send()
                        .await
                        .map(|r| r.status().is_success())
                        .unwrap_or(false)
                });
                if ok {
                    ready = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            if !ready {
                let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": {
                        "code": "SERVER_START_TIMEOUT",
                        "message": format!("gpui_telegram_server (pid {pid}) did not become ready on {status_url}")
                    }
                }));
                return ExitCode::from(1);
            }

            print_json(&json!({
                "ok": true,
                "data": {
                    "pid": pid,
                    "port": port,
                    "serverUrl": server_url,
                    "dataDir": data_path.to_string_lossy(),
                    "logFile": log_path.to_string_lossy()
                },
                "error": null
            }));
            ExitCode::SUCCESS
        }
        "server-stop" => {
            let mut data_dir = String::new();
            let mut pid_arg: Option<u32> = None;
            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--data-dir" | "--sandbox" if i + 1 < args.len() => {
                        data_dir = args[i + 1].clone();
                        i += 2;
                    }
                    "--pid" if i + 1 < args.len() => {
                        pid_arg = args[i + 1].parse().ok();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            let pid_file = PathBuf::from(&data_dir).join("server.pid");
            let pid = pid_arg.or_else(|| {
                fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok())
            });
            let Some(pid) = pid else {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": "PID_NOT_FOUND", "message": "No server.pid found in --data-dir and no --pid provided" }
                }));
                return ExitCode::from(1);
            };
            let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
            for _ in 0..30 {
                let alive = Command::new("kill")
                    .arg("-0")
                    .arg(pid.to_string())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !alive {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = fs::remove_file(&pid_file);
            print_json(&json!({
                "ok": true,
                "data": { "stopped": true, "pid": pid },
                "error": null
            }));
            ExitCode::SUCCESS
        }
        "invoke" => {
            let mut sandbox = String::new();
            let mut server = "http://127.0.0.1:8080".to_string();
            let mut domain = String::new();
            let mut action = String::new();
            let mut payload = "{}".to_string();

            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--sandbox" if i + 1 < args.len() => {
                        sandbox = args[i + 1].clone();
                        i += 2;
                    }
                    "--server" if i + 1 < args.len() => {
                        server = args[i + 1].clone();
                        i += 2;
                    }
                    "--domain" if i + 1 < args.len() => {
                        domain = args[i + 1].clone();
                        i += 2;
                    }
                    "--action" if i + 1 < args.len() => {
                        action = args[i + 1].clone();
                        i += 2;
                    }
                    "--payload" if i + 1 < args.len() => {
                        payload = args[i + 1].clone();
                        i += 2;
                    }
                    _ => i += 1,
                }
            }

            if sandbox.trim().is_empty() || domain.trim().is_empty() || action.trim().is_empty() {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": {
                        "code": "USAGE_ERROR",
                        "message": "invoke requires --sandbox <dir> --domain <domain> --action <action> [--server <url>] [--payload <json>]"
                    }
                }));
                return ExitCode::from(2);
            }

            let engine = TelegramCoreEngine::new();
            if let Err(err) = engine.init(make_init_cfg(Path::new(&sandbox), &server)) {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": err.code, "message": err.message },
                    "generation": engine.generation()
                }));
                return ExitCode::from(1);
            }

            let env_dto = engine.invoke_envelope(&domain, &action, &payload);
            let _ = engine.shutdown();

            if env_dto.ok {
                let parsed: Value = serde_json::from_str(&env_dto.data_json).unwrap_or(Value::Null);
                print_json(&json!({
                    "ok": true,
                    "data": parsed,
                    "generation": env_dto.generation,
                    "error": null
                }));
                ExitCode::SUCCESS
            } else {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": {
                        "code": env_dto.error_code,
                        "message": env_dto.error_message
                    },
                    "generation": env_dto.generation
                }));
                ExitCode::from(1)
            }
        }
        "ui-session" => {
            let mut sandbox = String::new();
            let mut server = "http://127.0.0.1:8080".to_string();
            let mut scenario_str = "[]".to_string();
            let mut script_path: Option<String> = None;

            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--sandbox" if i + 1 < args.len() => {
                        sandbox = args[i + 1].clone();
                        i += 2;
                    }
                    "--server" if i + 1 < args.len() => {
                        server = args[i + 1].clone();
                        i += 2;
                    }
                    "--scenario" if i + 1 < args.len() => {
                        scenario_str = args[i + 1].clone();
                        i += 2;
                    }
                    "--script" | "--scenario-file" if i + 1 < args.len() => {
                        script_path = Some(args[i + 1].clone());
                        i += 2;
                    }
                    _ => i += 1,
                }
            }

            if let Some(p) = script_path {
                match fs::read_to_string(&p) {
                    Ok(s) => scenario_str = s,
                    Err(e) => {
                        print_json(&json!({
                            "ok": false,
                            "data": null,
                            "error": { "code": "IO_ERROR", "message": format!("Failed reading scenario script '{p}': {e}") }
                        }));
                        return ExitCode::from(2);
                    }
                }
            }

            if sandbox.trim().is_empty() {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": "USAGE_ERROR", "message": "ui-session requires --sandbox <dir>" }
                }));
                return ExitCode::from(2);
            }

            let parsed_root: Value = match serde_json::from_str(&scenario_str) {
                Ok(v) => v,
                Err(e) => {
                    print_json(&json!({
                        "ok": false,
                        "data": null,
                        "error": { "code": "INVALID_JSON", "message": format!("Invalid scenario JSON: {e}") }
                    }));
                    return ExitCode::from(2);
                }
            };

            let engine = TelegramCoreEngine::new();
            if let Err(err) = engine.init(make_init_cfg(Path::new(&sandbox), &server)) {
                print_json(&json!({
                    "ok": false,
                    "data": null,
                    "error": { "code": err.code, "message": err.message }
                }));
                return ExitCode::from(1);
            }
            let mut rx = engine.subscribe_broadcast();

            match run_ui_session(&engine, &parsed_root) {
                Ok(mut out) => {
                    let mut push_events = Vec::new();
                    while let Ok(ev_str) = rx.try_recv() {
                        let ev_val: Value = serde_json::from_str(&ev_str)
                            .unwrap_or_else(|_| Value::String(ev_str));
                        push_events.push(ev_val);
                    }
                    out["pushEvents"] = Value::Array(push_events);
                    let _ = engine.shutdown();
                    print_json(&json!({
                        "ok": true,
                        "data": out,
                        "error": null
                    }));
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    let _ = engine.shutdown();
                    print_json(&json!({
                        "ok": false,
                        "data": null,
                        "error": {
                            "code": err.code,
                            "message": err.message
                        }
                    }));
                    ExitCode::from(1)
                }
            }
        }
        "inspect-artifacts" => {
            let root = repo_root();
            let mut errors: Vec<String> = Vec::new();

            let arm64_so = root.join("entry/libs/arm64-v8a/libtelegram_core.so");
            let x64_so = root.join("entry/libs/x86_64/libtelegram_core.so");
            let dts_path = root.join("entry/src/main/cpp/types/libtelegram_core/index.d.ts");
            let oh_pkg_path = root.join("entry/src/main/cpp/types/libtelegram_core/oh-package.json5");

            let arm64_info = match check_elf_magic_and_arch(&arm64_so) {
                Ok((arch, needed, has_reg)) => {
                    if arch != "aarch64" {
                        errors.push(format!("Expected aarch64 for {}, got {arch}", arm64_so.display()));
                    }
                    if !needed.iter().any(|n| n == "libace_napi.z.so") {
                        errors.push("arm64-v8a/libtelegram_core.so missing DT_NEEDED libace_napi.z.so".into());
                    }
                    if needed.iter().any(|n| n == "libc++_shared.so")
                        && !root.join("entry/libs/arm64-v8a/libc++_shared.so").is_file()
                    {
                        errors.push("arm64-v8a/libc++_shared.so required by DT_NEEDED but missing".into());
                    }
                    json!({ "exists": true, "arch": arch, "needed": needed, "napiRegistered": has_reg })
                }
                Err(e) => {
                    errors.push(e);
                    json!({ "exists": false })
                }
            };

            let x64_info = match check_elf_magic_and_arch(&x64_so) {
                Ok((arch, needed, has_reg)) => {
                    if arch != "x86_64" {
                        errors.push(format!("Expected x86_64 for {}, got {arch}", x64_so.display()));
                    }
                    if !needed.iter().any(|n| n == "libace_napi.z.so") {
                        errors.push("x86_64/libtelegram_core.so missing DT_NEEDED libace_napi.z.so".into());
                    }
                    if needed.iter().any(|n| n == "libc++_shared.so")
                        && !root.join("entry/libs/x86_64/libc++_shared.so").is_file()
                    {
                        errors.push("x86_64/libc++_shared.so required by DT_NEEDED but missing".into());
                    }
                    json!({ "exists": true, "arch": arch, "needed": needed, "napiRegistered": has_reg })
                }
                Err(e) => {
                    errors.push(e);
                    json!({ "exists": false })
                }
            };

            let dts_ok = match fs::read_to_string(&dts_path) {
                Ok(content) => {
                    let has_default = content.contains("export default telegramCore");
                    let has_init = content.contains("initCore");
                    let has_invoke = content.contains("invokeAction");
                    if !has_default || !has_init || !has_invoke {
                        errors.push("index.d.ts missing required initCore / invokeAction / export default telegramCore declarations".into());
                    }
                    has_default && has_init && has_invoke
                }
                Err(e) => {
                    errors.push(format!("Missing index.d.ts: {e}"));
                    false
                }
            };

            if !oh_pkg_path.is_file() {
                errors.push(format!("Missing {}", oh_pkg_path.display()));
            }

            let sign_dir = PathBuf::from(
                env::var("OHOS_SIGNING_DIR").unwrap_or_else(|_| "/home/antigravity/toolchains/signing".into()),
            );
            let signing_ok = sign_dir.join("harmonytg.p12").is_file()
                && sign_dir.join("harmonytg-app.cer").is_file()
                && sign_dir.join("harmonytg-release.p7b").is_file();
            if !signing_ok {
                errors.push("Missing PKCS#12 keystore, cert chain, or signed .p7b profile in toolchains/signing/".into());
            }

            // Inspect Stage-Model HAP / APP packages when built (M1_sub2 / build_ohos.sh)
            let unsigned_hap = root.join("entry/build/default/outputs/default/entry-default-unsigned.hap");
            let signed_hap = root.join("entry/build/default/outputs/default/entry-default-signed.hap");
            let ohostest_hap = root.join("entry/build/default/outputs/ohosTest/entry-ohosTest-unsigned.hap");
            let signed_app = root.join("build/outputs/default/harmony-telegram-default-signed.app");

            let require_hap = args.iter().any(|a| a == "--require-hap")
                || root.join("AppScope/app.json5").is_file();

            let mut hap_report = json!({ "checked": require_hap });
            if require_hap {
                for (label, path) in [
                    ("unsignedHap", &unsigned_hap),
                    ("signedHap", &signed_hap),
                    ("ohosTestHap", &ohostest_hap),
                    ("signedApp", &signed_app),
                ] {
                    if !path.is_file() {
                        errors.push(format!("Expected package artifact missing: {}", path.display()));
                    } else if let Ok(entries) = inspect_zip_entries(path) {
                        if label != "signedApp" {
                            for req_entry in ["module.json", "pack.info", "ets/modules.abc", "resources.index"] {
                                if !entries.iter().any(|e| e == req_entry) {
                                    errors.push(format!("{} missing zip entry '{req_entry}'", path.display()));
                                }
                            }
                        }
                        hap_report[label] = json!({
                            "path": path.to_string_lossy(),
                            "entryCount": entries.len()
                        });
                    } else {
                        errors.push(format!("Failed reading zip entries of {}", path.display()));
                    }
                }
            }

            if errors.is_empty() {
                print_json(&json!({
                    "ok": true,
                    "data": {
                        "arm64So": arm64_info,
                        "x86_64So": x64_info,
                        "indexDtsValid": dts_ok,
                        "signingChainPresent": signing_ok,
                        "packages": hap_report
                    },
                    "error": null
                }));
                ExitCode::SUCCESS
            } else {
                print_json(&json!({
                    "ok": false,
                    "data": {
                        "arm64So": arm64_info,
                        "x86_64So": x64_info,
                        "indexDtsValid": dts_ok,
                        "signingChainPresent": signing_ok,
                        "packages": hap_report
                    },
                    "error": {
                        "code": "ARTIFACT_INSPECTION_FAILED",
                        "message": errors.join("; "),
                        "errors": errors
                    }
                }));
                ExitCode::from(1)
            }
        }
        "waveform-test" => {
            let mut bar_count: usize = 100;
            if args.len() >= 3 && args[1] == "--bars" {
                bar_count = args[2].parse::<usize>().unwrap_or(100);
            }
            let mut pcm_bytes = Vec::with_capacity(48_000 * 2);
            for idx in 0..48_000usize {
                let t = idx as f64 / 48_000.0;
                let env = (t * std::f64::consts::PI).sin();
                let sample = ((2.0 * std::f64::consts::PI * 440.0 * t).sin() * env * 24_000.0) as i16;
                pcm_bytes.extend_from_slice(&sample.to_le_bytes());
            }
            let engine = TelegramCoreEngine::new();
            let packed = engine.encode_waveform_5bit_bytes(&pcm_bytes);
            let bars = engine.decode_waveform_5bit_bars(&packed, bar_count);
            let floats = engine.decode_waveform_5bit_floats(&packed);
            print_json(&json!({
                "ok": packed.len() == 63 && floats.len() == 100,
                "data": {
                    "packedByteLength": packed.len(),
                    "decodedBarCount": bars.len(),
                    "floatCount": floats.len(),
                    "barsSample": &bars[..bars.len().min(10)]
                },
                "error": null
            }));
            ExitCode::SUCCESS
        }
        "vad-test" => {
            let mut sample_rate: u32 = 48_000;
            let mut speech_frames: usize = 3;
            let mut i = 1usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--sample-rate" if i + 1 < args.len() => {
                        sample_rate = args[i + 1].parse().unwrap_or(48_000);
                        i += 2;
                    }
                    "--frames" if i + 1 < args.len() => {
                        speech_frames = args[i + 1].parse().unwrap_or(3);
                        i += 2;
                    }
                    _ => i += 1,
                }
            }
            let engine = TelegramCoreEngine::new();
            {
                let mut talk = engine.talk.lock();
                for _ in 0..5 {
                    let _ = talk.coordinator.enqueue_audio(vec![1u8; 640]);
                }
            }
            let samples_per_20ms = ((sample_rate as usize) * 20) / 1000;
            let mut frame_bytes = Vec::with_capacity(samples_per_20ms * 2);
            for idx in 0..samples_per_20ms {
                let s: i16 = if idx % 2 == 0 { 11_000 } else { -11_000 };
                frame_bytes.extend_from_slice(&s.to_le_bytes());
            }
            let mut last = Value::Null;
            for _ in 0..speech_frames {
                last = engine.process_talk_vad_pcm(&frame_bytes, sample_rate);
            }
            print_json(&json!({
                "ok": true,
                "data": last,
                "error": null
            }));
            ExitCode::SUCCESS
        }
        other => {
            print_json(&json!({
                "ok": false,
                "data": null,
                "error": {
                    "code": "UNKNOWN_SUBCOMMAND",
                    "message": format!("Unsupported subcommand '{other}'")
                }
            }));
            ExitCode::from(2)
        }
    }
}
