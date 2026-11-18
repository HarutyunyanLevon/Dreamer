//! Secrets Dreamer keeps outside the workspace: the SpriteCook API key, in the OS credential
//! store (Windows Credential Manager). The workspace is plain files that may end up in git, so a
//! key never goes there.

use crate::error::{AppError, Result};

const SERVICE: &str = "app.dreamer.desktop";
const SPRITECOOK: &str = "spritecook-api-key";

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, SPRITECOOK).map_err(|e| AppError::Invalid(format!("the credential store is not available: {e}")))
}

/// The stored SpriteCook key, if any. Never logged.
pub fn spritecook_key() -> Option<String> {
    if let Ok(k) = std::env::var("DREAMER_SPRITECOOK_KEY_OVERRIDE") {
        return (!k.trim().is_empty()).then(|| k.trim().to_string());
    }
    entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

/// Stores the key (trimmed); an empty key deletes it.
pub fn set_spritecook_key(key: &str) -> Result<()> {
    let key = key.trim();
    let e = entry()?;
    if key.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(AppError::Invalid(format!("could not remove the key: {err}"))),
        };
    }
    if key.len() > 400 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::Invalid("that doesn't look like an API key".into()));
    }
    e.set_password(key).map_err(|err| AppError::Invalid(format!("could not save the key: {err}")))
}

/// The key with all but its prefix and last 4 characters hidden (for the Settings dialog).
pub fn mask(key: &str) -> String {
    let n = key.chars().count();
    if n <= 8 {
        return "••••".into();
    }
    let prefix: String = key.chars().take_while(|c| *c != '_').chain(key.chars().skip_while(|c| *c != '_').take(1)).collect();
    let prefix = if prefix.len() < n / 2 { prefix } else { String::new() };
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{prefix}••••{tail}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn masks_keep_only_the_prefix_and_the_tail() {
        assert_eq!(super::mask("sc_live_abcdefghijklmn"), "sc_••••klmn");
        assert_eq!(super::mask("short"), "••••");
    }
}
