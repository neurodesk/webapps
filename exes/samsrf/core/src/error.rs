use std::fmt;

/// Every failure the crate reports. Messages are user-facing: they name the file,
/// variable or function at fault, as SamSrf's `samsrf_error` messages do.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// A file could not be parsed. `format` is the container (GIFTI, MAT v5, ...).
    Format { format: &'static str, message: String },
    /// A model JSON field is missing or has the wrong shape.
    Model(String),
    /// A model expression could not be parsed or evaluated.
    Expression(String),
    /// Inputs that cannot be combined (volume counts, vertex counts, ...).
    Shape(String),
    /// A SamSrf option this port does not support.
    NotImplemented(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Format { format, message } => write!(f, "{format}: {message}"),
            Error::Model(message) => write!(f, "model: {message}"),
            Error::Expression(message) => write!(f, "expression: {message}"),
            Error::Shape(message) => write!(f, "{message}"),
            Error::NotImplemented(what) => write!(f, "{what} is not supported by this port"),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn format(format: &'static str, message: impl Into<String>) -> Self {
        Error::Format { format, message: message.into() }
    }
}
