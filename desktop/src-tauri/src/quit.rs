//! Closing the window or quitting ICMM while Settings has unsaved changes
//! asks first (#118's U07): the page says when it has them, and a close or
//! quit meanwhile goes to the page as a question instead. The window comes
//! forward to ask, and a page that doesn't answer within 2 s, because it
//! hung or its process died, can't lose anything more: ICMM quits.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// The event a close or quit sends the page while it has unsaved changes.
pub const EVENT: &str = "quit_requested";

/// How long the page has to answer before ICMM quits anyway.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);

/// Whether a close or quit asks the page first.
pub struct Guard {
    /// The page has a form with unsaved changes.
    guarded: AtomicBool,
    /// The page answered Discard and quit.
    going: AtomicBool,
    /// The latest question the page hasn't answered yet, 0 for none.
    asked: AtomicU64,
    /// The last question's number.
    questions: AtomicU64,
}

impl Guard {
    pub const fn new() -> Self {
        Self {
            guarded: AtomicBool::new(false),
            going: AtomicBool::new(false),
            asked: AtomicU64::new(0),
            questions: AtomicU64::new(0),
        }
    }

    /// What the page says: whether it has unsaved changes. Saying anything
    /// answers a question it was asked.
    pub fn set(&self, guarded: bool) {
        self.guarded.store(guarded, Ordering::SeqCst);
        self.asked.store(0, Ordering::SeqCst);
    }

    /// A close or quit asked for now: the question for the page, numbered,
    /// or `None` when it goes ahead.
    pub fn ask(&self) -> Option<u64> {
        if !self.asks() {
            return None;
        }
        let n = self.questions.fetch_add(1, Ordering::SeqCst) + 1;
        self.asked.store(n, Ordering::SeqCst);
        Some(n)
    }

    /// Whether question `n` is still the page's latest, and unanswered.
    pub fn unanswered(&self, n: u64) -> bool {
        self.asked.load(Ordering::SeqCst) == n
    }

    /// A page load: the page before it, and its changes, are gone.
    pub fn loaded(&self) {
        self.set(false);
    }

    /// Whether a close or quit asked for now goes to the page instead.
    pub fn asks(&self) -> bool {
        self.guarded.load(Ordering::SeqCst) && !self.going.load(Ordering::SeqCst)
    }

    /// The page answered Discard and quit: nothing asks again.
    pub fn go(&self) {
        self.going.store(true, Ordering::SeqCst);
    }
}

impl Default for Guard {
    fn default() -> Self {
        Self::new()
    }
}

/// The app's one guard.
pub static GUARD: Guard = Guard::new();

/// A close or quit was asked for: answers whether to stop it, having asked
/// the page instead, in a window brought forward so the question shows.
pub fn ask_first(app: &AppHandle) -> bool {
    let Some(n) = GUARD.ask() else {
        return false;
    };
    tracing::info!("asking before quitting: the page has unsaved changes");
    if let Some(window) = app.get_webview_window("main") {
        // Minimized, hidden or behind another app, the question would go unseen.
        let shown = window
            .unminimize()
            .and_then(|()| window.show())
            .and_then(|()| window.set_focus());
        if let Err(e) = shown {
            tracing::warn!("couldn't bring the window forward to ask: {e}");
        }
    }
    if let Err(e) = app.emit(EVENT, ()) {
        // A page that can't be asked can't lose anything by going.
        tracing::warn!("couldn't ask the page before quitting: {e}");
        return false;
    }
    let app = app.clone();
    let waited = std::thread::Builder::new()
        .name("quit-answer".into())
        .spawn(move || {
            std::thread::sleep(ANSWER_WITHIN);
            if GUARD.unanswered(n) {
                tracing::warn!("the page didn't answer whether to quit; quitting");
                quit(&app);
            }
        });
    if let Err(e) = waited {
        tracing::warn!("couldn't wait for the page's answer: {e}");
    }
    true
}

/// Quits ICMM without asking again.
pub fn quit(app: &AppHandle) {
    GUARD.go();
    app.exit(0);
}

/// On macOS, ⌘Q, the menu's and the Dock's Quit and a logout all ask
/// `applicationShouldTerminate:`, which tao's app delegate doesn't answer:
/// this adds it, so they ask the page first as closing the window does.
#[cfg(target_os = "macos")]
pub fn ask_on_terminate() {
    use std::ffi::{c_char, c_void};

    #[link(name = "objc", kind = "dylib")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_addMethod(
            class: *mut c_void,
            name: *mut c_void,
            imp: *const c_void,
            types: *const c_char,
        ) -> i8;
    }

    /// `NSTerminateCancel` or `NSTerminateNow`.
    extern "C" fn should_terminate(_: *mut c_void, _: *mut c_void, _: *mut c_void) -> usize {
        let stop = crate::active::try_app().is_some_and(ask_first);
        if stop { 0 } else { 1 }
    }

    // SAFETY: the runtime's own lookups; the method's types say what
    // `should_terminate` takes and returns: an NSUInteger, self, _cmd and
    // the NSApplication.
    unsafe {
        let class = objc_getClass(c"TaoAppDelegateParent".as_ptr());
        if class.is_null() {
            return tracing::warn!("no app delegate to ask before quitting");
        }
        let name = sel_registerName(c"applicationShouldTerminate:".as_ptr());
        let added = class_addMethod(
            class,
            name,
            should_terminate as *const c_void,
            c"Q@:@".as_ptr(),
        );
        if added == 0 {
            tracing::warn!("the app delegate already answers applicationShouldTerminate:");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_goes_ahead_until_the_page_has_unsaved_changes() {
        let guard = Guard::new();
        assert!(!guard.asks());
        guard.set(true);
        assert!(guard.asks());
        guard.set(false);
        assert!(!guard.asks());
    }

    #[test]
    fn discard_and_quit_goes_without_asking_again() {
        let guard = Guard::new();
        guard.set(true);
        guard.go();
        assert!(!guard.asks());
    }

    #[test]
    fn a_question_stays_unanswered_until_the_page_says_anything() {
        let guard = Guard::new();
        guard.set(true);
        let asked = guard.ask().expect("guarded");
        assert!(guard.unanswered(asked));
        guard.set(true);
        assert!(!guard.unanswered(asked));
    }

    #[test]
    fn only_the_latest_question_waits_for_its_answer() {
        let guard = Guard::new();
        guard.set(true);
        let first = guard.ask().expect("guarded");
        let second = guard.ask().expect("guarded");
        assert!(!guard.unanswered(first));
        assert!(guard.unanswered(second));
    }

    #[test]
    fn an_unguarded_close_asks_nothing() {
        assert_eq!(Guard::new().ask(), None);
    }

    #[test]
    fn a_page_load_forgets_the_changes_of_the_page_before() {
        let guard = Guard::new();
        guard.set(true);
        guard.loaded();
        assert!(!guard.asks());
    }
}
