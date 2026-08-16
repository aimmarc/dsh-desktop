//! Server manager: locates the bundled Node runtime, probes the target port,
//! spawns `dsh web`, waits for readiness, and cleans up the process tree on
//! exit. If something already answers on the port (a user-started `dsh web`,
//! a leftover instance), it is reused and never killed.
//!
//! Process-tree guarantees: on Windows the child is placed in a Job Object
//! with KILL_ON_JOB_CLOSE, so if this process dies for ANY reason (normal
//! exit, crash, taskkill) the OS terminates the whole dsh tree; the explicit
//! `kill_tree` path is then only a courtesy for graceful teardown. On Unix
//! the child leads its own process group via setsid and `kill_tree` sends
//! SIGTERM to the group.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// Default port, matching the desktop launcher's `dsh web` convention.
const DEFAULT_PORT: u16 = 3080;
/// How long to wait for the server to become ready.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// Probe interval while waiting for readiness.
const PROBE_INTERVAL: Duration = Duration::from_millis(250);

/// Windows Job Object handle wrapped for RAII; lives as long as the child.
#[cfg(windows)]
struct JobObject(windows_sys::Win32::Foundation::HANDLE);
// HANDLE is a raw pointer; safe to move across threads here because the
// handle is only ever used from the main thread (spawn/stop), and the
// process lifetime semantics (KILL_ON_JOB_CLOSE) do not depend on which
// thread drops it.
#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}
#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Create a Job Object that kills every process in it when the last handle
/// closes (i.e. when this process dies), and assign `child` to it.
#[cfg(windows)]
fn assign_job(child: &mut Child) -> Option<JobObject> {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    };
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
    use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = 0x2000;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let _ = windows_sys::Win32::Foundation::CloseHandle(job);
            return None;
        }
        let pid = child.id() as u32;
        let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if proc.is_null() {
            let _ = windows_sys::Win32::Foundation::CloseHandle(job);
            return None;
        }
        let assigned = AssignProcessToJobObject(job, proc);
        let _ = windows_sys::Win32::Foundation::CloseHandle(proc);
        if assigned == 0 {
            let _ = windows_sys::Win32::Foundation::CloseHandle(job);
            return None;
        }
        Some(JobObject(job))
    }
}

/// Process tree kill helper: on Windows `taskkill /T /F` (needs the child to
/// live in its own process group, which we set via CREATE_NEW_PROCESS_GROUP);
/// on Unix we kill the process group we created with setsid.
#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID"])
        .arg(child.id().to_string())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(child: &mut Child) {
    // The child was spawned with process_group(0) → it leads its own group
    // whose id equals its pid. Kill the whole group, then reap the child.
    unsafe {
        libc_kill(-(child.id() as i32), libc::SIGTERM);
    }
    let _ = child.wait();
}

#[cfg(not(windows))]
mod libc {
    pub const SIGTERM: i32 = 15;
    #[link(name = "c")]
    extern "C" {
        pub fn kill(pid: i32, sig: i32) -> i32;
    }
}

#[cfg(not(windows))]
fn libc_kill(pid: i32, sig: i32) -> i32 {
    unsafe { libc::kill(pid, sig) }
}

/// The one running child we own (None when we reused an existing server).
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Windows Job Object keeping the child tree alive-scoped to this process
/// (KILL_ON_JOB_CLOSE). Held for the lifetime of the spawned server.
#[cfg(windows)]
static JOB: Mutex<Option<JobObject>> = Mutex::new(None);

fn probe(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(800),
    )
    .is_ok()
}

fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Locate the bundled Node executable under the app's resource directory:
/// `resources/runtime/node/node(.exe)` (as declared in tauri.conf.json's
/// `bundle.resources`). Falls back to a `node` on PATH for dev builds.
fn find_node(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let candidates = [
        // Packaged layout: <resource_dir>/node/node.exe
        resource_dir(app).map(|d| d.join("node").join(exe)),
        // Dev fallback: PATH node
        None,
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Some(found) = which_node_on_path() {
        return Ok(found);
    }
    Err(i18n(
        "找不到内置 Node 运行时，且 PATH 上也没有 node。请重新安装应用。",
        "Bundled Node runtime not found and no node on PATH. Please reinstall the app.",
    ))
}

/// The app's resource dir, normalized to a plain absolute path. Tauri may
/// return a Windows extended-length path (`\\?\C:\...`) which Node's
/// resolution cannot handle (`lstat 'C:'`), so strip that prefix here.
fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    #[cfg(windows)]
    {
        let s = dir.as_os_str().to_string_lossy();
        let stripped = s.strip_prefix("\\\\?\\").unwrap_or(&s);
        // `\\?\UNC\server\share` → `\\server\share`
        let stripped = stripped.strip_prefix("UNC\\").map(|rest| format!("\\\\{rest}")).unwrap_or_else(|| stripped.to_string());
        return Some(PathBuf::from(stripped));
    }
    #[cfg(not(windows))]
    {
        Some(dir)
    }
}

fn which_node_on_path() -> Option<PathBuf> {
    let output = Command::new("node").arg("--version").output().ok()?;
    if output.status.success() {
        // `node --version` succeeded → node is callable on PATH. We still
        // need its absolute path; resolve via `where`/`which`.
        let (prog, flag) = if cfg!(windows) { ("where", "node") } else { ("which", "node") };
        let out = Command::new(prog).arg(flag).output().ok()?;
        if out.status.success() {
            let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
            if !first.is_empty() {
                return Some(PathBuf::from(first));
            }
        }
    }
    None
}

/// Locate the launcher script that boots `dsh web`:
/// `<resource_dir>/runtime/launch.js`.
fn find_launch(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let candidate = resource_dir(app).map(|d| d.join("runtime").join("launch.js"));
    match candidate {
        Some(p) if p.is_file() => Ok(p),
        _ => Err(i18n(
            "未找到内置运行时 launch.js（预期位于 resources/runtime/launch.js）。",
            "Bundled runtime launch.js not found (expected at resources/runtime/launch.js).",
        )),
    }
}

fn default_port() -> u16 {
    std::env::var("DSH_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Whether the UI language is Chinese (follows the dsh shell convention).
fn is_zh() -> bool {
    let lang = std::env::var("LANG")
        .or_else(|_| std::env::var("LC_ALL"))
        .unwrap_or_default()
        .to_lowercase();
    lang.starts_with("zh") || lang.starts_with("cmn")
}

/// Short bilingual error helper: returns the Chinese or English string.
fn i18n(zh: &str, en: &str) -> String {
    if is_zh() { zh.to_string() } else { en.to_string() }
}

pub struct ServerManager;

impl ServerManager {
    /// Ensure the dsh server is up on the target port and return its URL.
    /// Reuses an already-answering server; otherwise spawns one and waits.
    pub async fn start(app: &tauri::AppHandle) -> Result<String, String> {
        let port = default_port();

        // 1. Already up? Reuse (and make sure we don't own it → stop() no-ops).
        if probe(port) {
            *CHILD.lock().unwrap() = None;
            return Ok(url_for(port));
        }

        // 2. Locate node + launch script.
        let node = find_node(app)?;
        let launch = find_launch(app)?;

        // 3. Spawn `node launch.js web --port <port>` in its own process
        //    group so we can kill the whole tree later. Child output goes to
        //    a log file so boot failures are diagnosable.
        let cwd = home_dir();
        let log_path = home_dir()
            .join(".dsh")
            .join("dsh-desktop-server.log");
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let log_file = std::fs::File::create(&log_path).map_err(|e| format!("{} {log_path:?}: {e}", i18n("无法创建日志文件", "cannot create log file")))?;
        let log_err = log_file.try_clone().map_err(|e| format!("{}: {e}", i18n("无法克隆日志句柄", "cannot clone log handle")))?;
        let mut cmd = Command::new(&node);
        cmd.arg(&launch)
            .arg("web")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(&cwd)
            .env("DSH_DESKTOP_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_err));

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000200); // CREATE_NEW_PROCESS_GROUP
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", i18n("启动 dsh 服务失败", "failed to start the dsh service")))?;

        // On Windows, assign the child to a kill-on-close Job Object so the
        // whole dsh tree dies with this process even on a hard kill/crash.
        #[cfg(windows)]
        {
            if let Some(job) = assign_job(&mut child) {
                *JOB.lock().unwrap() = Some(job);
            }
        }
        *CHILD.lock().unwrap() = Some(child);

        // 4. Wait for readiness.
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if probe(port) {
                return Ok(url_for(port));
            }
            if Instant::now() >= deadline {
                Self::stop(app);
                return Err(i18n(
                    &format!("dsh 服务在 {:.0} 秒内未就绪（端口 {port}）。请检查是否被其他程序占用。", READY_TIMEOUT.as_secs_f64()),
                    &format!("The dsh service did not become ready within {:.0}s (port {port}). Check whether another program occupies it.", READY_TIMEOUT.as_secs_f64()),
                ));
            }
            tokio::time::sleep(PROBE_INTERVAL).await;
        }
    }

    /// Kill the server tree we own (if any). Safe to call any number of times.
    pub fn stop(_app: &tauri::AppHandle) {
        let mut guard = CHILD.lock().unwrap();
        if let Some(mut child) = guard.take() {
            kill_tree(&mut child);
        }
        // Drop the Job Object; on Windows with KILL_ON_JOB_CLOSE this also
        // guarantees any stragglers in the tree are terminated.
        #[cfg(windows)]
        {
            *JOB.lock().unwrap() = None;
        }
    }
}
