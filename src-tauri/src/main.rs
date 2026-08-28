// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer crashes on launch with "Error 71 (Protocol
        // error) dispatching to Wayland display" on several Wayland compositors
        // (reported on KDE/Manjaro, KDE/Arch — cli-ck#164, cli-ck#162). Disable it
        // under Wayland unless the user already set a preference. No effect on X11.
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Disable macOS press-and-hold character popup, so key repeat works in terminal.
        use objc2::msg_send;
        use objc2_foundation::{ns_string, NSUserDefaults};
        unsafe {
            let defaults = NSUserDefaults::standardUserDefaults();
            let key = ns_string!("ApplePressAndHoldEnabled");
            let _: () = msg_send![&defaults, setBool: false, forKey: key];
        }
    }

    cli_ck_lib::run()
}
