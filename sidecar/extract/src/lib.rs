//! Document extractors for the work-wiki sidecar (Stories 7.2–7.4).
//!
//! THE WORKER CANNOT DO THIS. Extract runs on the owner's machine, behind the
//! loopback sidecar, because the kernel runs on Cloudflare Workers and neither
//! reaches `127.0.0.1` nor has the CPU budget for a hundred-page PDF. The Node
//! claim loop in `sidecar/server.mjs` fetches bytes from the kernel, writes
//! them to a temp file, and shells out to the binary this crate builds.
//!
//! NOTHING HERE IMPORTS `src/lib`, and nothing here reaches the network: the
//! only inputs are a temp file and a format name, and the only output is
//! Markdown on stdout. MinerU (the optional PDF escalation) is the Node half's
//! business, not this crate's — a Rust process that could POST a document
//! somewhere would make "documents stay on this machine" unverifiable from
//! here.
//!
//! One Markdown convention across every format: a document becomes headings,
//! paragraphs, lists and GFM tables, because that is what the kernel's
//! two-step Ingest reads. A format-specific shape (slide markers, sheet names)
//! is expressed as a heading rather than as a sidecar-only annotation nothing
//! downstream understands.

pub mod docx;
pub mod ebook;
pub mod md;
pub mod ooxml;
pub mod pdf;
pub mod pptx;
pub mod sheets;

use std::fmt;
use std::path::Path;

/// What went wrong, in a sentence the owner will read in Activity.
#[derive(Debug)]
pub struct ExtractError(pub String);

impl fmt::Display for ExtractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ExtractError {}

impl From<String> for ExtractError {
    fn from(value: String) -> Self {
        ExtractError(value)
    }
}

impl From<&str> for ExtractError {
    fn from(value: &str) -> Self {
        ExtractError(value.to_string())
    }
}

impl From<std::io::Error> for ExtractError {
    fn from(value: std::io::Error) -> Self {
        ExtractError(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ExtractError>;

/// The formats the Intake door is allowed to enqueue.
///
/// Kept in lockstep with `INTAKE_EXTRACT_EXTENSIONS` in
/// `src/lib/workbench-intake.ts`: a format accepted there and unknown here
/// stores bytes that can only ever fail, and a format handled here but refused
/// there is dead code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Pdf,
    Docx,
    Pptx,
    Xlsx,
    Xls,
    Ods,
    Epub,
    Mobi,
}

impl Format {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "pdf" => Some(Format::Pdf),
            "docx" => Some(Format::Docx),
            "pptx" => Some(Format::Pptx),
            "xlsx" => Some(Format::Xlsx),
            "xls" => Some(Format::Xls),
            "ods" => Some(Format::Ods),
            "epub" => Some(Format::Epub),
            "mobi" => Some(Format::Mobi),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Docx => "docx",
            Format::Pptx => "pptx",
            Format::Xlsx => "xlsx",
            Format::Xls => "xls",
            Format::Ods => "ods",
            Format::Epub => "epub",
            Format::Mobi => "mobi",
        }
    }

    /// Human label for a failure sentence, matching `DOCUMENT_FORMAT_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            Format::Pdf => "PDF",
            Format::Docx => "Word",
            Format::Pptx => "PowerPoint",
            Format::Xlsx | Format::Xls => "Excel",
            Format::Ods => "ODS",
            Format::Epub => "EPUB",
            Format::Mobi => "MOBI",
        }
    }
}

/// Extract Markdown from bytes already on disk.
///
/// Takes a PATH rather than a buffer because `calamine` and `pdf-extract` both
/// want a file, and because the claim loop has already written the temp file
/// it is obliged to delete.
pub fn extract(path: &Path, format: Format) -> Result<String> {
    let markdown = match format {
        Format::Pdf => pdf::extract(path)?,
        Format::Docx => docx::extract(path)?,
        Format::Pptx => pptx::extract(path)?,
        Format::Xlsx | Format::Xls | Format::Ods => sheets::extract(path)?,
        Format::Epub => ebook::extract_epub(path)?,
        Format::Mobi => ebook::extract_mobi(path)?,
    };
    let trimmed = md::tidy(&markdown);
    if trimmed.trim().is_empty() {
        // EMPTY IS A FAILURE, not a compile of nothing. A scanned PDF with no
        // text layer is exactly the case MinerU exists for, and returning ""
        // would have the kernel build a Page out of an empty file.
        return Err(ExtractError(format!(
            "{} extract produced no text.",
            format.label()
        )));
    }
    Ok(trimmed)
}
