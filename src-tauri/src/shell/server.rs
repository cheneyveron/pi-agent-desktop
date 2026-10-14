use std::{io, process::Child, sync::Mutex};

// Each platform's `stop()` path needs its own imports; the split out of
// lib.rs lost these, which only a Windows build notices.
#[cfg(windows)]
use std::{os::windows::process::CommandExt as _, process::Command};
#[cfg(unix)]
use std::{
    thread,
    time::{Duration, Instant},
};

pub struct DesktopServer {
    child: Mutex<Option<Child>>,
}

/// When true, closing the main window quits the app; otherwise it hides to tray.
pub struct CloseQuits(pub Mutex<bool>);

pub struct DesktopApiToken(pub String);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl DesktopServer {
    pub fn empty() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn running(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    pub fn try_wait_child(&self) -> io::Result<Option<std::process::ExitStatus>> {
        let Ok(mut guard) = self.child.lock() else {
            return Ok(None);
        };
        match guard.as_mut() {
            Some(child) => child.try_wait(),
            None => Ok(None),
        }
    }

    pub fn stop(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        let Some(child) = guard.take() else { return };
        terminate_process_tree(child);
    }
}

fn terminate_process_tree(mut child: Child) {
    #[cfg(unix)]
    {
        let pid = child.id();
        unsafe {
            // The Node server owns its process group, so this also stops any
            // agent/tool subprocesses that are active when the App quits.
            libc::kill(-(pid as i32), libc::SIGTERM);
        }

        // Reap on a detached thread so the quit/exit path never blocks on the
        // Node server's shutdown. The packaged server installs no SIGTERM
        // handler, so it normally dies immediately, but any child that ignores
        // SIGTERM must not stall the UI for the full grace window. If the main
        // process exits before this thread finishes, the server's own parent
        // watchdog (desktop/server-launcher.cjs) exits it within ~1 s, so no
        // orphan is left behind either way.
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => return,
                }
            }

            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        });
    }

    #[cfg(windows)]
    {
        // taskkill /T terminates the packaged Node server and any agent/tool
        // subprocesses it started. CREATE_NO_WINDOW avoids flashing a console.
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for DesktopServer {
    fn drop(&mut self) {
        self.stop();
    }
}
