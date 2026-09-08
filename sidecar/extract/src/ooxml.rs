//! ZIP + XML helpers shared by the PPTX pass, the DOCX fallback and EPUB.
//!
//! OOXML and EPUB are both "a ZIP with XML inside", and three extractors that
//! each opened their own archive would each have their own idea of what a
//! corrupt file looks like. One opener means one refusal sentence.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::{ExtractError, Result};

pub type Archive = zip::ZipArchive<File>;

/// Open a ZIP container, naming the format in the failure the owner reads.
pub fn open(path: &Path, label: &str) -> Result<Archive> {
    let file = File::open(path)?;
    zip::ZipArchive::new(file)
        .map_err(|error| ExtractError(format!("{label} could not be opened: {error}")))
}

/// Read one entry as UTF-8. `None` when the archive has no such entry.
pub fn read_entry(archive: &mut Archive, name: &str) -> Result<Option<String>> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(ExtractError(error.to_string())),
    };
    let mut buffer = Vec::new();
    entry.read_to_end(&mut buffer)?;
    Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
}

/// Every entry name in the archive, sorted so slide order is deterministic.
pub fn entry_names(archive: &Archive) -> Vec<String> {
    let mut names: Vec<String> = archive.file_names().map(str::to_string).collect();
    names.sort();
    names
}

/// Concatenate the text of every `<w:t>`-style element in an XML document.
///
/// `text_tag` names the leaf that carries characters and `break_tags` the
/// elements that end a line. Written against quick-xml's event stream rather
/// than a DOM because a slide deck's XML is mostly markup and holding it all
/// in memory buys nothing.
pub fn text_of(
    xml: &str,
    text_tag: &str,
    break_tags: &[&str],
    paragraph_tag: Option<&str>,
) -> Result<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = local_name(tag.name().as_ref());
                if name == text_tag {
                    in_text = true;
                } else if Some(name.as_str()) == paragraph_tag {
                    flush(&mut paragraphs, &mut current);
                }
            }
            Ok(Event::End(tag)) => {
                let name = local_name(tag.name().as_ref());
                if name == text_tag {
                    in_text = false;
                } else if Some(name.as_str()) == paragraph_tag {
                    flush(&mut paragraphs, &mut current);
                }
            }
            Ok(Event::Empty(tag)) => {
                let name = local_name(tag.name().as_ref());
                if break_tags.contains(&name.as_str()) {
                    current.push('\n');
                }
            }
            Ok(Event::Text(text)) => {
                if in_text {
                    current.push_str(&text.unescape().unwrap_or_default());
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(ExtractError(format!("XML could not be read: {error}")));
            }
            _ => {}
        }
    }
    flush(&mut paragraphs, &mut current);
    Ok(paragraphs)
}

fn flush(out: &mut Vec<String>, current: &mut String) {
    let text = current.trim().to_string();
    current.clear();
    if !text.is_empty() {
        out.push(text);
    }
}

/// `w:t` → `t`. Namespaced names are what OOXML uses everywhere.
pub fn local_name(raw: &[u8]) -> String {
    let name = String::from_utf8_lossy(raw);
    match name.rsplit_once(':') {
        Some((_, local)) => local.to_string(),
        None => name.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_name_drops_the_namespace() {
        assert_eq!(local_name(b"w:t"), "t");
        assert_eq!(local_name(b"t"), "t");
    }

    #[test]
    fn text_of_groups_by_paragraph() {
        let xml = "<doc><p><t>one</t><t> two</t></p><p><t>three</t></p></doc>";
        let out = text_of(xml, "t", &[], Some("p")).unwrap();
        assert_eq!(out, vec!["one two".to_string(), "three".to_string()]);
    }
}
