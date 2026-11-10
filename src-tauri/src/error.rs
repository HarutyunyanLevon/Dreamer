use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse {context}: {message}")]
    Parse { context: String, message: String },
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        AppError::Io { context: context.into(), source }
    }
}

/// Tauri commands return errors to the UI as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
