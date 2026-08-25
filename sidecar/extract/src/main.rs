//! `work-wiki-extract` — one document in, Markdown out.
//!
//! Invoked by the Node claim loop in `sidecar/extract-loop.mjs`, never by the kernel:
//! the Worker cannot reach this machine. Arguments name a file already on disk
//! and the format the Intake door recognised; the answer is JSON on stdout so
//! the loop can carry `cacheHit` back to the kernel without a second channel.
//!
//! THE CACHE LIVES HERE, keyed on the SHA-256 the kernel already computed for
//! the raw bytes. A second drop of the same PDF reads `<cache>/<sha>.md` and
//! never enters `pdf-extract` — which is the acceptance criterion, and also the
//! difference between a re-drop costing milliseconds and costing a minute. It
//! is keyed on bytes, so it cannot go stale: different bytes are a different
//! key.
//!
//! Exit code 0 with `{"ok":true,...}`, or exit code 1 with `{"ok":false,
//! "error":"…"}` — the error string is what Activity shows the owner verbatim.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use sha2::{Digest, Sha256};
use work_wiki_extract::{extract, Format};

struct Args {
    path: PathBuf,
    format: Format,
    sha256: Option<String>,
    cache_dir: Option<PathBuf>,
}

fn usage() -> String {
    "usage: work-wiki-extract --format <pdf|docx|pptx|xlsx|xls|ods|epub|mobi> \
     [--sha256 <hex>] [--cache-dir <dir>] <file>"
        .to_string()
}

fn parse_args(argv: Vec<String>) -> std::result::Result<Args, String> {
    let mut path: Option<PathBuf> = None;
    let mut format: Option<Format> = None;
    let mut sha256: Option<String> = None;
    let mut cache_dir: Option<PathBuf> = None;
    let mut iter = argv.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--format" => {
                let value = iter.next().ok_or_else(usage)?;
                format =
                    Some(Format::parse(&value).ok_or_else(|| format!("unknown format: {value}"))?);
            }
            "--sha256" => sha256 = iter.next(),
            "--cache-dir" => cache_dir = iter.next().map(PathBuf::from),
            "--help" | "-h" => return Err(usage()),
            other if other.starts_with("--") => {
                return Err(format!("unknown option: {other}"));
            }
            other => path = Some(PathBuf::from(other)),
        }
    }
    Ok(Args {
        path: path.ok_or_else(usage)?,
        format: format.ok_or_else(usage)?,
        sha256,
        cache_dir,
    })
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(message) => return fail(&message),
    };

    // The digest is supplied by the kernel so both halves key on the same
    // string; hashing here as a fallback keeps the binary usable on its own.
    let digest = match args.sha256 {
        Some(value) if !value.trim().is_empty() => value.trim().to_ascii_lowercase(),
        _ => match fs::read(&args.path) {
            Ok(bytes) => {
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                format!("{:x}", hasher.finalize())
            }
            Err(error) => return fail(&format!("The file could not be read: {error}")),
        },
    };

    if let Some(dir) = args.cache_dir.as_deref() {
        if let Some(cached) = read_cache(dir, &digest) {
            return emit(&cached, true);
        }
    }

    let markdown = match extract(&args.path, args.format) {
        Ok(markdown) => markdown,
        Err(error) => return fail(&error.to_string()),
    };

    if let Some(dir) = args.cache_dir.as_deref() {
        write_cache(dir, &digest, &markdown);
    }
    emit(&markdown, false)
}

fn cache_path(dir: &Path, digest: &str) -> Option<PathBuf> {
    // A digest is hex and fixed length. Anything else came from somewhere it
    // should not have, and joining it into a path would be a write primitive.
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(dir.join(format!("{digest}.md")))
}

fn read_cache(dir: &Path, digest: &str) -> Option<String> {
    let path = cache_path(dir, digest)?;
    let text = fs::read_to_string(path).ok()?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Fail-soft: a cache that could not be written is a slower next run, not a
/// failed extract, and the text is already on its way to the kernel.
fn write_cache(dir: &Path, digest: &str, markdown: &str) {
    let Some(path) = cache_path(dir, digest) else {
        return;
    };
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(path, markdown);
}

fn emit(markdown: &str, cache_hit: bool) -> ExitCode {
    let payload = serde_json::json!({
        "ok": true,
        "cacheHit": cache_hit,
        "chars": markdown.chars().count(),
        "markdown": markdown,
    });
    println!("{payload}");
    ExitCode::SUCCESS
}

fn fail(message: &str) -> ExitCode {
    let payload = serde_json::json!({ "ok": false, "error": message });
    println!("{payload}");
    ExitCode::FAILURE
}
