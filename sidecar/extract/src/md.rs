//! Shared Markdown shaping, so five extractors agree on what output looks like.

/// Collapse runs of blank lines and strip trailing spaces.
///
/// Every extractor emits blank lines defensively (a paragraph boundary is
/// cheaper to add than to reconstruct), and three of them append one after a
/// section that turned out to be empty. Tidying once here is what keeps the
/// stored Markdown from carrying the shape of whichever parser produced it.
pub fn tidy(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut blank_run = 0usize;
    for line in input.replace('\r', "").lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(trimmed);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Make one line safe to place inside a GFM table cell.
///
/// A pipe splits the cell and a newline ends the row, so a spreadsheet value
/// containing either would silently reshape the table around it.
pub fn cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string()
}

/// Render a header row plus body rows as a GFM table.
///
/// Returns an empty string for no rows, so a caller can concatenate without
/// checking and still not emit a table with no cells in it.
pub fn table(header: &[String], rows: &[Vec<String>]) -> String {
    if header.is_empty() && rows.is_empty() {
        return String::new();
    }
    let width = header
        .len()
        .max(rows.iter().map(Vec::len).max().unwrap_or(0));
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut head: Vec<String> = header.to_vec();
    head.resize(width, String::new());
    out.push_str(&format!("| {} |\n", head.join(" | ")));
    out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
    for row in rows {
        let mut cells = row.clone();
        cells.resize(width, String::new());
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out
}

/// Strip HTML/XHTML tags to text, keeping block boundaries as blank lines.
///
/// Deliberately NOT a general HTML→Markdown converter: web clips take the
/// kernel's Readability path, and the XHTML inside an EPUB is a book chapter
/// whose structure is carried by its headings. Headings are preserved because
/// they are the chapter's navigation; everything else becomes prose.
pub fn html_to_text(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0usize;
    let mut skip_depth = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let end = match html[i..].find('>') {
                Some(offset) => i + offset,
                None => break,
            };
            let tag = &html[i + 1..end];
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            let closing = tag.starts_with('/');
            match name.as_str() {
                "script" | "style" | "head" => {
                    if closing {
                        skip_depth = skip_depth.saturating_sub(1);
                    } else if !tag.ends_with('/') {
                        skip_depth += 1;
                    }
                }
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    if skip_depth == 0 {
                        if closing {
                            out.push_str("\n\n");
                        } else {
                            let level = name[1..].parse::<usize>().unwrap_or(1);
                            out.push_str("\n\n");
                            out.push_str(&"#".repeat(level.clamp(1, 6)));
                            out.push(' ');
                        }
                    }
                }
                "p" | "div" | "br" | "li" | "tr" | "section" | "blockquote" => {
                    if skip_depth == 0 {
                        out.push('\n');
                        if name != "br" {
                            out.push('\n');
                        }
                    }
                }
                _ => {}
            }
            i = end + 1;
            continue;
        }
        if skip_depth == 0 {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    tidy(&decode_entities(&out))
}

/// The handful of entities an EPUB actually uses. Numeric forms included.
pub fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        let Some(semi) = tail[..tail.len().min(12)].find(';') else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" | "#39" => Some("'".to_string()),
            "nbsp" | "#160" => Some(" ".to_string()),
            other => other
                .strip_prefix('#')
                .and_then(|n| {
                    if let Some(hex) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        n.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32)
                .map(|c| c.to_string()),
        };
        match decoded {
            Some(text) => {
                out.push_str(&text);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_collapses_blank_runs() {
        assert_eq!(tidy("a\n\n\n\nb  \n"), "a\n\nb");
    }

    #[test]
    fn cell_escapes_pipes_and_newlines() {
        assert_eq!(cell("a|b\nc"), "a\\|b c");
    }

    #[test]
    fn table_pads_short_rows() {
        let out = table(
            &["A".into(), "B".into()],
            &[vec!["1".into()], vec!["2".into(), "3".into()]],
        );
        assert!(out.contains("| A | B |"));
        assert!(out.contains("| --- | --- |"));
        assert!(out.contains("| 1 |  |"));
        assert!(out.contains("| 2 | 3 |"));
    }

    #[test]
    fn html_keeps_headings_and_paragraphs() {
        let out = html_to_text("<h1>Title</h1><p>One</p><p>Two &amp; more</p>");
        assert!(out.starts_with("# Title"));
        assert!(out.contains("One"));
        assert!(out.contains("Two & more"));
    }

    #[test]
    fn html_drops_script_bodies() {
        let out = html_to_text("<p>Keep</p><script>alert('no')</script>");
        assert!(out.contains("Keep"));
        assert!(!out.contains("alert"));
    }
}
