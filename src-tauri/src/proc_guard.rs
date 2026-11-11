//! Keeps child process *trees* from outliving Dreamer.
//!
//! On Windows `Child::kill()` terminates only that one process: the Claude Code processes the
//! sidecar starts would keep running as strays. A Job Object with "kill on job close" fixes both
//! exits: `kill_all()` ends the whole tree on Quit, and if dreamer.exe dies without a clean exit
//! (stopping `tauri dev`, a crash, Task Manager) Windows closes the job handle and kills the tree
//! itself. Processes started by a process in the job join it automatically.
//! On other platforms this is a no-op (the sidecar also exits when its stdin closes).

use std::process::Child;

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // A job handle is a kernel handle: usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> std::io::Result<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            }
        }
        pub fn assign(&self, child: &Child) -> std::io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
        }
        pub fn kill_all(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // Closing the last handle kills everything still in the job (KILL_ON_JOB_CLOSE).
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::process::Child;
    pub struct Job;
    impl Job {
        pub fn new() -> std::io::Result<Job> {
            Ok(Job)
        }
        pub fn assign(&self, _child: &Child) -> std::io::Result<()> {
            Ok(())
        }
        pub fn kill_all(&self) {}
    }
}

/// A child process and everything it starts; the whole tree ends with `kill_all()` or on drop.
pub struct TreeGuard(Option<imp::Job>);

impl TreeGuard {
    /// Puts `child` (and its future descendants) under the guard. If the OS refuses (very old
    /// Windows, or the app itself runs in a job that forbids nesting), the guard is inert and the
    /// caller's own `Child::kill()` remains the fallback.
    pub fn adopt(child: &Child) -> TreeGuard {
        match imp::Job::new().and_then(|j| j.assign(child).map(|_| j)) {
            Ok(j) => TreeGuard(Some(j)),
            Err(e) => {
                eprintln!("[dreamer] couldn't put the sidecar in a job object ({e}); only the sidecar itself will be stopped on quit");
                TreeGuard(None)
            }
        }
    }
    #[cfg(test)]
    pub fn is_active(&self) -> bool {
        self.0.is_some()
    }
    /// Ends the child and every process it started.
    pub fn kill_all(&self) {
        if let Some(j) = &self.0 {
            j.kill_all();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    fn wait_gone(pids: &[u32]) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if pids.iter().all(|p| !alive(*p)) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// Node script: after 300ms start a long-running *detached* node child, print its pid, and keep
    /// running. The delay lets the test adopt the parent first. Detached matters: Node already
    /// kills its non-detached children when it dies (libuv puts them in its own kill-on-close
    /// job), but a detached child, or anything a child starts that way, is orphaned.
    const TREE: &str = "setTimeout(()=>{const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);},300);setInterval(()=>{},1000);";

    fn spawn_tree() -> Option<(Child, TreeGuard, u32)> {
        let mut parent = Command::new("node").args(["-e", TREE]).stdout(Stdio::piped()).stdin(Stdio::null()).spawn().ok()?;
        let guard = TreeGuard::adopt(&parent);
        let mut line = String::new();
        BufReader::new(parent.stdout.take().unwrap()).read_line(&mut line).ok()?;
        let child = line.trim().parse().ok()?;
        Some((parent, guard, child))
    }

    #[test]
    fn kill_all_ends_the_whole_tree() {
        let Some((mut parent, guard, child)) = spawn_tree() else {
            eprintln!("node not on PATH; skipped");
            return;
        };
        assert!(guard.is_active());
        assert!(alive(parent.id()) && alive(child));
        guard.kill_all();
        assert!(wait_gone(&[parent.id(), child]), "parent and grandchild both ended");
        let _ = parent.wait();
    }

    #[test]
    fn dropping_the_guard_ends_the_tree_like_an_app_crash() {
        let Some((mut parent, guard, child)) = spawn_tree() else {
            eprintln!("node not on PATH; skipped");
            return;
        };
        assert!(alive(child));
        // Closing the job handle is what Windows does when dreamer.exe dies without cleaning up.
        drop(guard);
        assert!(wait_gone(&[parent.id(), child]), "the tree ends when the job handle closes");
        let _ = parent.wait();
    }

    #[test]
    fn plain_kill_leaves_the_grandchild_running() {
        // Why the guard exists: Child::kill() alone orphans a detached process the child started.
        let mut parent = Command::new("node").args(["-e", TREE]).stdout(Stdio::piped()).stdin(Stdio::null()).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(parent.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let child: u32 = line.trim().parse().unwrap();
        parent.kill().unwrap();
        let _ = parent.wait();
        std::thread::sleep(Duration::from_millis(500));
        let orphan_alive = alive(child);
        let _ = Command::new("taskkill").args(["/PID", &child.to_string(), "/F"]).output();
        assert!(orphan_alive, "without the job, the grandchild outlives its parent");
    }
}
