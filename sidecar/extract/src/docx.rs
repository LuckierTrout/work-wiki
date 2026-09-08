//! DOCX → Markdown: headings, lists and tables survive the trip.
//!
//! TWO PASSES, in this order, because one of them is a better reader and the
//! other one always works. `docx-rs` understands numbering, styles and table
//! structure, so it is tried first and is what produces a real `#` heading and
//! a real `-` list. A DOCX it refuses — an older producer, a file some tool
//! rewrote — falls back to reading `word/document.xml` straight out of the ZIP
//! in this same process, which recovers the prose even when the model does not
//! load. Only when BOTH fail does the owner see a failure, and then it really
//! is a corrupt document.

use std::fs;
use std::path::Path;

use docx_rs::{
    DocumentChild, Paragraph, ParagraphChild, RunChild, Table, TableCellContent, TableChild,
    TableRowChild,
};

use crate::{md, ooxml, ExtractError, Result};

pub fn extract(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    match extract_with_docx_rs(&bytes) {
        Ok(text) if !text.trim().is_empty() => Ok(text),
        _ => extract_wordprocessingml(path),
    }
}

/// The structured pass. Everything Markdown needs is in the model here.
fn extract_with_docx_rs(bytes: &[u8]) -> Result<String> {
    let parsed = std::panic::catch_unwind(|| docx_rs::read_docx(bytes));
    let docx = match parsed {
        Ok(Ok(docx)) => docx,
        Ok(Err(error)) => return Err(ExtractError(format!("Word could not be read: {error}"))),
        Err(_) => {
            return Err(ExtractError(
                "Word could not be read: the document is malformed.".to_string(),
            ))
        }
    };
    let mut out = String::new();
    for child in docx.document.children {
        match child {
            DocumentChild::Paragraph(paragraph) => {
                out.push_str(&render_paragraph(&paragraph));
            }
            DocumentChild::Table(table) => {
                out.push_str(&render_table(&table));
            }
            _ => {}
        }
    }
    Ok(md::tidy(&out))
}

/// `Heading1` / `heading 1` / `Title` → the `#` level the owner will see.
///
/// Word stores the style id, and producers disagree about spacing and case, so
/// the id is normalized before it is matched rather than compared verbatim.
fn heading_level(style: &str) -> Option<usize> {
    let normalized: String = style
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized == "title" {
        return Some(1);
    }
    let digits = normalized.strip_prefix("heading")?;
    digits.parse::<usize>().ok().map(|n| n.clamp(1, 6))
}

fn paragraph_text(paragraph: &Paragraph) -> String {
    let mut text = String::new();
    for child in &paragraph.children {
        if let ParagraphChild::Run(run) = child {
            for run_child in &run.children {
                match run_child {
                    RunChild::Text(value) => text.push_str(&value.text),
                    RunChild::Tab(_) => text.push('\t'),
                    RunChild::Break(_) => text.push('\n'),
                    _ => {}
                }
            }
        }
    }
    text.trim().to_string()
}

fn render_paragraph(paragraph: &Paragraph) -> String {
    let text = paragraph_text(paragraph);
    if text.is_empty() {
        return "\n".to_string();
    }
    if let Some(level) = paragraph
        .property
        .style
        .as_ref()
        .and_then(|style| heading_level(&style.val))
    {
        return format!("\n{} {}\n\n", "#".repeat(level), text);
    }
    if paragraph.property.numbering_property.is_some() {
        return format!("- {text}\n");
    }
    format!("\n{text}\n")
}

fn render_table(table: &Table) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in &table.rows {
        let TableChild::TableRow(row) = row;
        let mut cells: Vec<String> = Vec::new();
        for cell in &row.cells {
            let TableRowChild::TableCell(cell) = cell;
            let mut text = String::new();
            for content in &cell.children {
                if let TableCellContent::Paragraph(paragraph) = content {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(&paragraph_text(paragraph));
                }
            }
            cells.push(md::cell(&text));
        }
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    // Word has no concept of a header row, so the FIRST row becomes one. A GFM
    // table needs a header to render at all, and promoting row one is what
    // every converter does; the alternative is an empty header nobody wanted.
    let header = rows.remove(0);
    format!("\n{}\n", md::table(&header, &rows))
}

/// The fallback: `word/document.xml` read as a flat stream of paragraphs.
///
/// Structure is lost (no headings, no list markers) because the style ids that
/// carry it live in a different part of the package — but the prose is intact,
/// which is the difference between a Source that compiles and one that does
/// not.
fn extract_wordprocessingml(path: &Path) -> Result<String> {
    let mut archive = ooxml::open(path, "Word")?;
    let xml = ooxml::read_entry(&mut archive, "word/document.xml")?.ok_or_else(|| {
        ExtractError("Word could not be read: no document part in the file.".to_string())
    })?;
    let paragraphs = ooxml::text_of(&xml, "t", &["br", "tab"], Some("p"))?;
    Ok(md::tidy(&paragraphs.join("\n\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_level_reads_the_common_style_spellings() {
        assert_eq!(heading_level("Heading1"), Some(1));
        assert_eq!(heading_level("heading 2"), Some(2));
        assert_eq!(heading_level("Heading-3"), Some(3));
        assert_eq!(heading_level("Title"), Some(1));
        assert_eq!(heading_level("Normal"), None);
    }

    #[test]
    fn heading_level_clamps_beyond_markdown() {
        assert_eq!(heading_level("Heading9"), Some(6));
    }
}
