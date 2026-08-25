//! PPTX → Markdown, slide by slide.
//!
//! ZIP + XML rather than a crate: a deck is `ppt/slides/slideN.xml`, each one a
//! DrawingML shape tree whose text is in `<a:t>` elements, and the one thing
//! the epic asks of it — that the output be navigable BY SLIDE — is a property
//! of how the parts are named, not of anything a parser would infer.
//!
//! Each slide becomes `## Slide N`, which is what makes the Source summary
//! navigable: the kernel's Markdown outline, Preview's headings and a citation
//! into the page all land on the same anchor. Speaker notes ride under the
//! slide they belong to rather than in a section of their own, so reading the
//! Markdown top to bottom is reading the deck in order.

use std::path::Path;

use crate::{md, ooxml, ExtractError, Result};

pub fn extract(path: &Path) -> Result<String> {
    let mut archive = ooxml::open(path, "PowerPoint")?;
    let names = ooxml::entry_names(&archive);
    let mut slides: Vec<(usize, String)> = Vec::new();
    for name in &names {
        let Some(number) = slide_number(name) else {
            continue;
        };
        let Some(xml) = ooxml::read_entry(&mut archive, name)? else {
            continue;
        };
        slides.push((number, xml));
    }
    if slides.is_empty() {
        return Err(ExtractError(
            "PowerPoint could not be read: no slides in the file.".to_string(),
        ));
    }
    slides.sort_by_key(|(number, _)| *number);

    let mut out = String::new();
    for (number, xml) in slides {
        let lines = ooxml::text_of(&xml, "t", &["br"], Some("p"))?;
        out.push_str(&format!("\n## Slide {number}\n\n"));
        if lines.is_empty() {
            // A slide with no text is still a slide, and skipping it would
            // renumber everything after it relative to the deck the owner sees.
            out.push_str("_No text on this slide._\n");
        } else {
            for line in lines {
                out.push_str(&line);
                out.push_str("\n\n");
            }
        }
        if let Some(notes) = notes_for(&mut archive, number)? {
            if !notes.trim().is_empty() {
                out.push_str("**Notes:** ");
                out.push_str(notes.trim());
                out.push_str("\n\n");
            }
        }
    }
    Ok(md::tidy(&out))
}

/// `ppt/slides/slide12.xml` → `12`. Anything else is not a slide part.
///
/// Matched on the NAME rather than by walking the presentation's relationship
/// graph: slide layouts and masters live under `ppt/slideLayouts/`, so the
/// prefix is already unambiguous, and a deck whose rels are damaged still has
/// readable slides.
pub fn slide_number(name: &str) -> Option<usize> {
    let rest = name.strip_prefix("ppt/slides/slide")?;
    rest.strip_suffix(".xml")?.parse::<usize>().ok()
}

fn notes_for(archive: &mut ooxml::Archive, number: usize) -> Result<Option<String>> {
    let name = format!("ppt/notesSlides/notesSlide{number}.xml");
    let Some(xml) = ooxml::read_entry(archive, &name)? else {
        return Ok(None);
    };
    let lines = ooxml::text_of(&xml, "t", &["br"], Some("p"))?;
    // PowerPoint writes the slide number into the notes part as its own
    // paragraph; carrying it through would put a bare digit in every note.
    let text = lines
        .into_iter()
        .filter(|line| line.trim() != number.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slide_number_reads_the_part_name() {
        assert_eq!(slide_number("ppt/slides/slide3.xml"), Some(3));
        assert_eq!(slide_number("ppt/slides/_rels/slide3.xml.rels"), None);
        assert_eq!(slide_number("ppt/slideLayouts/slideLayout3.xml"), None);
    }
}
