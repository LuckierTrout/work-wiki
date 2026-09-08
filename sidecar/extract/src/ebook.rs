//! EPUB and MOBI, both in this process.
//!
//! EPUB is a ZIP of XHTML with an OPF manifest, so it reuses the same opener
//! the OOXML formats use: `container.xml` names the package document, the
//! package document carries the metadata and the SPINE, and the spine is the
//! reading order. Walking the spine rather than the ZIP's own entry order is
//! what makes chapters come out in the order the book is meant to be read;
//! sorting entry names would interleave front matter, notes and appendices by
//! filename.
//!
//! MOBI is a PalmDB container with a PalmDOC-compressed text stream, decoded
//! here rather than through a crate: the format is small, static and twenty
//! years old, and the decoder below is shorter than the dependency's own
//! surface. Metadata comes from the EXTH header, which is the only place a
//! MOBI keeps a title that is not the file name.

use std::fs;
use std::path::Path;

use crate::{md, ooxml, ExtractError, Result};

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

pub fn extract_epub(path: &Path) -> Result<String> {
    let mut archive = ooxml::open(path, "EPUB")?;
    let container =
        ooxml::read_entry(&mut archive, "META-INF/container.xml")?.ok_or_else(|| {
            ExtractError("EPUB could not be read: no container manifest.".to_string())
        })?;
    let opf_path = attribute(&container, "rootfile", "full-path").ok_or_else(|| {
        ExtractError("EPUB could not be read: the container names no package.".to_string())
    })?;
    let opf = ooxml::read_entry(&mut archive, &opf_path)?
        .ok_or_else(|| ExtractError(format!("EPUB could not be read: {opf_path} is missing.")))?;
    let base = opf_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");

    let mut out = String::new();
    if let Some(title) = element_text(&opf, "dc:title").or_else(|| element_text(&opf, "title")) {
        out.push_str(&format!("# {}\n\n", md::decode_entities(&title)));
    }
    for (label, tag) in [("Author", "dc:creator"), ("Published", "dc:date")] {
        if let Some(value) = element_text(&opf, tag) {
            out.push_str(&format!("**{label}:** {}\n\n", md::decode_entities(&value)));
        }
    }

    let manifest = manifest_hrefs(&opf);
    let mut read_any = false;
    for id in spine_order(&opf) {
        let Some(href) = manifest.get(&id) else {
            continue;
        };
        let name = join(base, href);
        let Some(xhtml) = ooxml::read_entry(&mut archive, &name)? else {
            continue;
        };
        let text = md::html_to_text(&xhtml);
        if text.trim().is_empty() {
            continue;
        }
        read_any = true;
        out.push_str(&text);
        out.push_str("\n\n");
    }
    if !read_any {
        return Err(ExtractError(
            "EPUB could not be read: no readable chapters in the spine.".to_string(),
        ));
    }
    Ok(md::tidy(&out))
}

/// `OEBPS` + `text/ch1.xhtml` → `OEBPS/text/ch1.xhtml`.
///
/// `..` segments are resolved rather than passed through: the result is a ZIP
/// entry name, and a name that walked out of the archive root would be looked
/// up as a literal (and missed) rather than doing damage — but a chapter
/// silently skipped is worse than one found.
pub fn join(base: &str, href: &str) -> String {
    // A manifest href is a URL, not a path: `text/ch1.xhtml#part2` is legal and
    // common (a spine that enters a chapter at an anchor), and so is a trailing
    // `?`. Kept, they became part of the ZIP entry name being looked up, the
    // entry was not found, and the chapter silently vanished from the extracted
    // book — with no error anywhere, because a missing entry is skipped.
    let href = href
        .split(['#', '?'])
        .next()
        .unwrap_or("")
        .trim();
    let raw = if base.is_empty() {
        href.to_string()
    } else {
        format!("{base}/{href}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Where `<tag>` opens, ignoring longer names that merely start the same way.
///
/// `container.xml` wraps `<rootfile>` in `<rootfiles>`, and a bare substring
/// search finds the WRAPPER first — then reads its (absent) attributes and
/// reports a package the EPUB does in fact name. So the character after the
/// name has to end it.
fn element_start(xml: &str, tag: &str) -> Option<usize> {
    let needle = format!("<{tag}");
    let mut from = 0usize;
    while let Some(offset) = xml[from..].find(&needle) {
        let at = from + offset;
        let after = xml[at + needle.len()..].chars().next();
        match after {
            Some(c) if c.is_whitespace() || c == '>' || c == '/' => return Some(at),
            None => return None,
            _ => from = at + needle.len(),
        }
    }
    None
}

/// The value of one attribute on the first element with this tag name.
fn attribute(xml: &str, tag: &str, name: &str) -> Option<String> {
    let open = element_start(xml, tag)?;
    let close = xml[open..].find('>')? + open;
    let element = &xml[open..close];
    let key = format!("{name}=");
    let at = element.find(&key)? + key.len();
    let quote = element[at..].chars().next()?;
    let rest = &element[at + 1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

/// The text between `<tag …>` and `</tag>`, tags inside it stripped.
fn element_text(xml: &str, tag: &str) -> Option<String> {
    let open = element_start(xml, tag)?;
    let content_start = xml[open..].find('>')? + open + 1;
    let close = xml[content_start..].find(&format!("</{tag}>"))? + content_start;
    let raw = &xml[content_start..close];
    let text = raw.split('<').next().unwrap_or(raw).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// `id` → `href` for every `<item>` in the OPF manifest.
fn manifest_hrefs(opf: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for chunk in opf.split("<item ").skip(1) {
        let element = match chunk.find('>') {
            Some(end) => &chunk[..end],
            None => continue,
        };
        let id = quoted(element, "id=");
        let href = quoted(element, "href=");
        if let (Some(id), Some(href)) = (id, href) {
            out.insert(id, md::decode_entities(&href));
        }
    }
    out
}

/// The `idref`s of the spine, in reading order.
fn spine_order(opf: &str) -> Vec<String> {
    let Some(start) = opf.find("<spine") else {
        return Vec::new();
    };
    let end = opf[start..]
        .find("</spine>")
        .map(|offset| start + offset)
        .unwrap_or(opf.len());
    opf[start..end]
        .split("<itemref")
        .skip(1)
        .filter_map(|chunk| {
            let element = chunk.split('>').next()?;
            quoted(element, "idref=")
        })
        .collect()
}

fn quoted(element: &str, key: &str) -> Option<String> {
    let at = element.find(key)? + key.len();
    let quote = element[at..].chars().next()?;
    let rest = &element[at + 1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

// ---------------------------------------------------------------------------
// MOBI
// ---------------------------------------------------------------------------

const PALMDB_HEADER_LEN: usize = 78;
const PALMDB_RECORD_ENTRY_LEN: usize = 8;

pub fn extract_mobi(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    let records = palmdb_records(&bytes)?;
    let record0 = records
        .first()
        .copied()
        .ok_or_else(|| ExtractError("MOBI could not be read: it has no records.".to_string()))?;
    let head = &bytes[record0.0..record0.1];
    if head.len() < 16 {
        return Err(ExtractError(
            "MOBI could not be read: the header is truncated.".to_string(),
        ));
    }
    let compression = u16::from_be_bytes([head[0], head[1]]);
    let text_record_count = u16::from_be_bytes([head[8], head[9]]) as usize;

    let mut text = String::new();
    if let Some(title) = exth_title(head) {
        text.push_str(&format!("# {title}\n\n"));
    }

    let mut raw: Vec<u8> = Vec::new();
    // Record 0 is the header this function just read; the text records follow it
    // and stop at whichever runs out first, the declared count or the file.
    let text_records = records
        .iter()
        .skip(1)
        .take(text_record_count.min(records.len().saturating_sub(1)));
    for &(start, end) in text_records {
        let chunk = &bytes[start..end];
        match compression {
            1 => raw.extend_from_slice(chunk),
            2 => raw.extend_from_slice(&palmdoc_decompress(chunk)),
            other => {
                return Err(ExtractError(format!(
                    "MOBI could not be read: compression {other} is not supported."
                )))
            }
        }
    }
    if raw.is_empty() {
        return Err(ExtractError(
            "MOBI could not be read: it contains no text records.".to_string(),
        ));
    }
    text.push_str(&md::html_to_text(&String::from_utf8_lossy(&raw)));
    Ok(md::tidy(&text))
}

/// `(start, end)` byte offsets of every PalmDB record.
fn palmdb_records(bytes: &[u8]) -> Result<Vec<(usize, usize)>> {
    if bytes.len() < PALMDB_HEADER_LEN + 2 {
        return Err(ExtractError(
            "MOBI could not be read: the file is too short.".to_string(),
        ));
    }
    let count = u16::from_be_bytes([bytes[76], bytes[77]]) as usize;
    let table_end = PALMDB_HEADER_LEN + count * PALMDB_RECORD_ENTRY_LEN;
    if count == 0 || bytes.len() < table_end {
        return Err(ExtractError(
            "MOBI could not be read: the record table is truncated.".to_string(),
        ));
    }
    let mut offsets: Vec<usize> = Vec::with_capacity(count);
    for index in 0..count {
        let at = PALMDB_HEADER_LEN + index * PALMDB_RECORD_ENTRY_LEN;
        let offset =
            u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        if offset > bytes.len() {
            return Err(ExtractError(
                "MOBI could not be read: a record points past the end of the file.".to_string(),
            ));
        }
        offsets.push(offset);
    }
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let start = offsets[index];
        let end = offsets.get(index + 1).copied().unwrap_or(bytes.len());
        out.push((start, end.max(start)));
    }
    Ok(out)
}

/// PalmDOC LZ77: literals, back-references and the packed space+letter form.
pub fn palmdoc_decompress(input: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(input.len() * 2);
    let mut i = 0usize;
    while i < input.len() {
        let byte = input[i];
        i += 1;
        match byte {
            0x00 => out.push(0x00),
            0x01..=0x08 => {
                let take = byte as usize;
                let end = (i + take).min(input.len());
                out.extend_from_slice(&input[i..end]);
                i = end;
            }
            0x09..=0x7f => out.push(byte),
            0x80..=0xbf => {
                if i >= input.len() {
                    break;
                }
                let pair = u16::from_be_bytes([byte, input[i]]);
                i += 1;
                let distance = ((pair >> 3) & 0x07ff) as usize;
                let length = ((pair & 0x0007) + 3) as usize;
                if distance == 0 || distance > out.len() {
                    continue;
                }
                let start = out.len() - distance;
                for offset in 0..length {
                    let value = out[start + offset];
                    out.push(value);
                }
            }
            0xc0..=0xff => {
                out.push(b' ');
                out.push(byte ^ 0x80);
            }
        }
    }
    out
}

/// The EXTH `updatedTitle` (503) record, the only reliable title in a MOBI.
fn exth_title(record0: &[u8]) -> Option<String> {
    let exth_at = record0.windows(4).position(|w| w == b"EXTH")?;
    let body = &record0[exth_at..];
    if body.len() < 12 {
        return None;
    }
    let count = u32::from_be_bytes([body[8], body[9], body[10], body[11]]) as usize;
    let mut at = 12usize;
    for _ in 0..count {
        if at + 8 > body.len() {
            break;
        }
        let kind = u32::from_be_bytes([body[at], body[at + 1], body[at + 2], body[at + 3]]);
        let len =
            u32::from_be_bytes([body[at + 4], body[at + 5], body[at + 6], body[at + 7]]) as usize;
        if len < 8 || at + len > body.len() {
            break;
        }
        if kind == 503 {
            let text = String::from_utf8_lossy(&body[at + 8..at + len])
                .trim()
                .to_string();
            return if text.is_empty() { None } else { Some(text) };
        }
        at += len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_resolves_relative_segments() {
        assert_eq!(join("OEBPS", "text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
        assert_eq!(
            join("OEBPS/text", "../images/a.xhtml"),
            "OEBPS/images/a.xhtml"
        );
        assert_eq!(join("", "ch1.xhtml"), "ch1.xhtml");
    }

    #[test]
    fn join_drops_a_fragment_or_query_before_resolving() {
        assert_eq!(join("OEBPS", "text/ch1.xhtml#part2"), "OEBPS/text/ch1.xhtml");
        assert_eq!(join("OEBPS", "text/ch1.xhtml?v=2"), "OEBPS/text/ch1.xhtml");
        assert_eq!(join("", "ch1.xhtml#a?b"), "ch1.xhtml");
    }

    #[test]
    fn spine_order_is_reading_order_not_manifest_order() {
        let opf = r#"<package><manifest>
            <item id="c2" href="two.xhtml"/>
            <item id="c1" href="one.xhtml"/>
        </manifest><spine>
            <itemref idref="c1"/><itemref idref="c2"/>
        </spine></package>"#;
        assert_eq!(spine_order(opf), vec!["c1".to_string(), "c2".to_string()]);
        let manifest = manifest_hrefs(opf);
        assert_eq!(manifest.get("c1").map(String::as_str), Some("one.xhtml"));
    }

    #[test]
    fn element_start_skips_a_longer_name_with_the_same_prefix() {
        let xml = "<rootfiles><rootfile full-path=\"a.opf\"/></rootfiles>";
        assert_eq!(
            attribute(xml, "rootfile", "full-path").as_deref(),
            Some("a.opf")
        );
    }

    #[test]
    fn metadata_comes_out_of_the_package_document() {
        let opf = "<package><metadata><dc:title>A Book</dc:title>\
            <dc:creator>An Author</dc:creator></metadata></package>";
        assert_eq!(element_text(opf, "dc:title").as_deref(), Some("A Book"));
        assert_eq!(
            element_text(opf, "dc:creator").as_deref(),
            Some("An Author")
        );
    }

    #[test]
    fn palmdoc_expands_literals_and_back_references() {
        // "abc" then a back-reference of length 3 at distance 3 → "abcabc".
        // A PalmDOC pair is 0x8000 | distance << 3 | (length - 3).
        let (distance, length) = (3u16, 3u16);
        let pair = 0x8000 | (distance << 3) | (length - 3);
        let mut input = b"abc".to_vec();
        input.extend_from_slice(&pair.to_be_bytes());
        assert_eq!(palmdoc_decompress(&input), b"abcabc".to_vec());
    }

    #[test]
    fn palmdoc_expands_the_packed_space_form() {
        assert_eq!(palmdoc_decompress(&[0xc1]), b" A".to_vec());
    }

    #[test]
    fn palmdb_rejects_a_truncated_file() {
        assert!(palmdb_records(&[0u8; 10]).is_err());
    }
}
