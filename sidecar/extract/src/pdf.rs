//! PDF text, through the pinned `pdf-extract` crate.
//!
//! The SHA-256 parse cache does not live here — it is the claim loop's, keyed
//! on the digest the kernel already computed, because a cache inside this
//! process would be thrown away with every invocation. What lives here is the
//! parse itself and the shaping of its output into paragraphs.

use std::path::Path;

use crate::{md, ExtractError, Result};

/// Extract text from a PDF and shape it into Markdown paragraphs.
pub fn extract(path: &Path) -> Result<String> {
    // `pdf-extract` panics on some malformed documents rather than returning an
    // error. A panic here would take down the whole invocation with an exit
    // code the claim loop can only report as "extract crashed", so it is caught
    // and turned into the same visible failure a corrupt DOCX gets.
    let path = path.to_path_buf();
    let parsed = std::panic::catch_unwind(move || pdf_extract::extract_text(&path));
    let text = match parsed {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => {
            return Err(ExtractError(format!("PDF could not be read: {error}")));
        }
        Err(_) => {
            return Err(ExtractError(
                "PDF could not be read: the document is malformed.".to_string(),
            ));
        }
    };
    Ok(shape(&text))
}

/// Turn extracted glyph runs into paragraphs.
///
/// `pdf-extract` emits hard line breaks wherever the page laid one out, so a
/// sentence that wrapped arrives as several lines. Joining a run of non-blank
/// lines into one paragraph is what makes the Markdown read as prose rather
/// than as a column of fragments — and blank-line boundaries and form feeds
/// are the only paragraph evidence a PDF carries.
pub fn shape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut paragraph = String::new();
    for raw in text.replace('\r', "").replace('\u{c}', "\n\n").lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !paragraph.is_empty() {
                out.push_str(paragraph.trim());
                out.push_str("\n\n");
                paragraph.clear();
            }
            continue;
        }
        if !paragraph.is_empty() {
            // A hyphen at a line end is a word broken across the wrap.
            if paragraph.ends_with('-') {
                paragraph.pop();
            } else {
                paragraph.push(' ');
            }
        }
        paragraph.push_str(line);
    }
    if !paragraph.is_empty() {
        out.push_str(paragraph.trim());
    }
    md::tidy(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_joins_wrapped_lines_into_paragraphs() {
        let out = shape("The quick brown\nfox jumps.\n\nSecond para.\n");
        assert_eq!(out, "The quick brown fox jumps.\n\nSecond para.");
    }

    #[test]
    fn shape_rejoins_hyphenated_breaks() {
        assert_eq!(shape("extra-\nordinary claim"), "extraordinary claim");
    }

    #[test]
    fn shape_treats_a_form_feed_as_a_paragraph_break() {
        assert_eq!(shape("page one\u{c}page two"), "page one\n\npage two");
    }
}
