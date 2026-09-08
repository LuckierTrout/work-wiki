//! End-to-end extract over documents this test builds byte by byte.
//!
//! FIXTURES ARE SYNTHESIZED, not committed. A checked-in DOCX is an opaque blob
//! a reader cannot audit and a reviewer cannot diff — and the properties under
//! test here (a heading survives, a slide is numbered, a sheet keeps its cell
//! types) are properties of the XML, which is right there in the test. The cost
//! is that these are minimal documents rather than ones Word produced; the
//! `docx` module's ZIP+XML fallback is what carries a real-world file whose
//! structured model refuses to load, and it is the path a minimal fixture
//! exercises too.

use std::io::Write;
use std::path::PathBuf;

use work_wiki_extract::{extract, Format};
use zip::write::SimpleFileOptions;

fn write_zip(name: &str, entries: &[(&str, String)]) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("work-wiki-extract-{}-{}", std::process::id(), name));
    let file = std::fs::File::create(&path).expect("fixture file");
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    for (entry, body) in entries {
        zip.start_file(*entry, options).expect("zip entry");
        zip.write_all(body.as_bytes()).expect("zip write");
    }
    zip.finish().expect("zip finish");
    path
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

fn docx_fixture() -> PathBuf {
    let document = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Review</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    let content_types = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>"#;
    write_zip(
        "structure.docx",
        &[
            ("[Content_Types].xml", content_types.to_string()),
            ("_rels/.rels", rels.to_string()),
            ("word/document.xml", document.to_string()),
        ],
    )
}

#[test]
fn docx_keeps_a_heading_a_list_and_a_table() {
    let path = docx_fixture();
    let markdown = extract(&path, Format::Docx).expect("docx extract");
    let _ = std::fs::remove_file(&path);

    assert!(
        markdown.contains("Quarterly Review"),
        "heading text missing:\n{markdown}"
    );
    assert!(
        markdown.contains("First item") && markdown.contains("Second item"),
        "list items missing:\n{markdown}"
    );
    assert!(
        markdown.contains("Region") && markdown.contains("North") && markdown.contains("12"),
        "table cells missing:\n{markdown}"
    );
}

#[test]
fn a_corrupt_docx_fails_visibly() {
    let path = std::env::temp_dir().join(format!("wwe-{}-broken.docx", std::process::id()));
    std::fs::write(&path, b"this is not a zip archive at all").expect("write");
    let error = extract(&path, Format::Docx).expect_err("corrupt docx must fail");
    let _ = std::fs::remove_file(&path);
    assert!(
        error.to_string().contains("Word"),
        "failure must name the format: {error}"
    );
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

fn slide_xml(lines: &[&str]) -> String {
    let shapes = lines
        .iter()
        .map(|line| {
            format!("<p:sp><p:txBody><a:p><a:r><a:t>{line}</a:t></a:r></a:p></p:txBody></p:sp>")
        })
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>{shapes}</p:spTree></p:cSld>
</p:sld>"#
    )
}

#[test]
fn pptx_is_slide_by_slide_and_navigable_by_slide() {
    let path = write_zip(
        "deck.pptx",
        &[
            ("ppt/slides/slide1.xml", slide_xml(&["Opening", "Agenda"])),
            ("ppt/slides/slide2.xml", slide_xml(&["Results"])),
            // Out of lexical order on purpose: `slide10` sorts before `slide2`
            // as a string, so a name sort would put it in the wrong place.
            ("ppt/slides/slide10.xml", slide_xml(&["Appendix"])),
        ],
    );
    let markdown = extract(&path, Format::Pptx).expect("pptx extract");
    let _ = std::fs::remove_file(&path);

    assert!(
        markdown.contains("## Slide 1"),
        "slide 1 heading:\n{markdown}"
    );
    assert!(
        markdown.contains("## Slide 2"),
        "slide 2 heading:\n{markdown}"
    );
    assert!(
        markdown.contains("## Slide 10"),
        "slide 10 heading:\n{markdown}"
    );
    assert!(markdown.contains("Opening") && markdown.contains("Agenda"));

    let one = markdown.find("## Slide 1").unwrap();
    let two = markdown.find("## Slide 2").unwrap();
    let ten = markdown.find("## Slide 10").unwrap();
    assert!(
        one < two && two < ten,
        "slides out of deck order:\n{markdown}"
    );
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

fn xlsx_fixture() -> PathBuf {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
    let workbook = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Totals" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#;
    let workbook_rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#;
    // `t="str"` is a formula-string cell, which calamine reads without a shared
    // string table — so the fixture stays one part smaller and still exercises
    // string, number and boolean cells side by side.
    let sheet1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="str"><v>Region</v></c>
      <c r="B1" t="str"><v>Units</v></c>
      <c r="C1" t="str"><v>Active</v></c>
    </row>
    <row r="2">
      <c r="A2" t="str"><v>North</v></c>
      <c r="B2"><v>12</v></c>
      <c r="C2" t="b"><v>1</v></c>
    </row>
    <row r="3">
      <c r="A3" t="str"><v>South</v></c>
      <c r="B3"><v>7.5</v></c>
      <c r="C3" t="b"><v>0</v></c>
    </row>
  </sheetData>
</worksheet>"#;
    let sheet2 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="str"><v>Second sheet</v></c></row>
  </sheetData>
</worksheet>"#;
    write_zip(
        "book.xlsx",
        &[
            ("[Content_Types].xml", content_types.to_string()),
            ("_rels/.rels", root_rels.to_string()),
            ("xl/workbook.xml", workbook.to_string()),
            ("xl/_rels/workbook.xml.rels", workbook_rels.to_string()),
            ("xl/worksheets/sheet1.xml", sheet1.to_string()),
            ("xl/worksheets/sheet2.xml", sheet2.to_string()),
        ],
    )
}

#[test]
fn every_sheet_becomes_a_markdown_table_with_its_cell_types() {
    let path = xlsx_fixture();
    let markdown = extract(&path, Format::Xlsx).expect("xlsx extract");
    let _ = std::fs::remove_file(&path);

    assert!(
        markdown.contains("## Totals"),
        "sheet 1 heading:\n{markdown}"
    );
    assert!(
        markdown.contains("## Notes"),
        "sheet 2 heading:\n{markdown}"
    );
    assert!(
        markdown.contains("| Region | Units | Active |"),
        "header row:\n{markdown}"
    );
    assert!(
        markdown.contains("| --- | --- | --- |"),
        "GFM rule:\n{markdown}"
    );
    // An integer stays an integer rather than becoming `12.0`, a float keeps
    // its fraction, and a boolean is legible as one.
    assert!(
        markdown.contains("| North | 12 | TRUE |"),
        "typed row:\n{markdown}"
    );
    assert!(
        markdown.contains("| South | 7.5 | FALSE |"),
        "typed row:\n{markdown}"
    );
    assert!(
        markdown.contains("Second sheet"),
        "second sheet body:\n{markdown}"
    );
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

#[test]
fn epub_yields_metadata_and_chapters_in_spine_order() {
    let container = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;
    let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Long Report</dc:title>
    <dc:creator>A Writer</dc:creator>
  </metadata>
  <manifest>
    <item id="two" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="one" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="one"/><itemref idref="two"/></spine>
</package>"#;
    let path = write_zip(
        "book.epub",
        &[
            ("META-INF/container.xml", container.to_string()),
            ("OEBPS/content.opf", opf.to_string()),
            (
                "OEBPS/ch1.xhtml",
                "<html><body><h1>Chapter One</h1><p>Opening line.</p></body></html>".to_string(),
            ),
            (
                "OEBPS/ch2.xhtml",
                "<html><body><h1>Chapter Two</h1><p>Closing line.</p></body></html>".to_string(),
            ),
        ],
    );
    let markdown = extract(&path, Format::Epub).expect("epub extract");
    let _ = std::fs::remove_file(&path);

    assert!(
        markdown.starts_with("# The Long Report"),
        "title:\n{markdown}"
    );
    assert!(
        markdown.contains("**Author:** A Writer"),
        "creator:\n{markdown}"
    );
    assert!(
        markdown.contains("# Chapter One"),
        "chapter heading:\n{markdown}"
    );
    assert!(
        markdown.contains("Opening line."),
        "chapter body:\n{markdown}"
    );
    let first = markdown.find("Chapter One").unwrap();
    let second = markdown.find("Chapter Two").unwrap();
    assert!(first < second, "spine order not preserved:\n{markdown}");
}

#[test]
fn a_corrupt_epub_fails_visibly() {
    let path = std::env::temp_dir().join(format!("wwe-{}-broken.epub", std::process::id()));
    std::fs::write(&path, b"not an archive").expect("write");
    let error = extract(&path, Format::Epub).expect_err("corrupt epub must fail");
    let _ = std::fs::remove_file(&path);
    assert!(
        error.to_string().contains("EPUB"),
        "names the format: {error}"
    );
}

// ---------------------------------------------------------------------------
// MOBI
// ---------------------------------------------------------------------------

/// Build a one-record uncompressed PalmDB/MOBI so the reader is exercised
/// against a real container rather than against its own helpers.
fn mobi_fixture(body: &str) -> PathBuf {
    let record_count: u16 = 2;
    let header_len = 78 + (record_count as usize) * 8;
    let mut out = vec![0u8; header_len];
    out[0..8].copy_from_slice(b"MOBIfix\0");
    out[60..64].copy_from_slice(b"BOOK");
    out[64..68].copy_from_slice(b"MOBI");
    out[76..78].copy_from_slice(&record_count.to_be_bytes());

    let mut record0 = vec![0u8; 16];
    record0[0..2].copy_from_slice(&1u16.to_be_bytes()); // compression: none
    record0[8..10].copy_from_slice(&1u16.to_be_bytes()); // one text record
    let record0_offset = header_len as u32;
    let text_offset = record0_offset + record0.len() as u32;

    for (index, offset) in [record0_offset, text_offset].into_iter().enumerate() {
        let at = 78 + index * 8;
        out[at..at + 4].copy_from_slice(&offset.to_be_bytes());
    }
    out.append(&mut record0);
    out.extend_from_slice(body.as_bytes());

    let path = std::env::temp_dir().join(format!("wwe-{}-book.mobi", std::process::id()));
    std::fs::write(&path, out).expect("write mobi");
    path
}

#[test]
fn mobi_text_records_become_markdown() {
    let path = mobi_fixture("<html><body><h1>Ebook Title</h1><p>Body text here.</p></body></html>");
    let markdown = extract(&path, Format::Mobi).expect("mobi extract");
    let _ = std::fs::remove_file(&path);
    assert!(markdown.contains("# Ebook Title"), "heading:\n{markdown}");
    assert!(markdown.contains("Body text here."), "body:\n{markdown}");
}

#[test]
fn a_corrupt_mobi_fails_visibly() {
    let path = std::env::temp_dir().join(format!("wwe-{}-broken.mobi", std::process::id()));
    std::fs::write(&path, b"tiny").expect("write");
    let error = extract(&path, Format::Mobi).expect_err("corrupt mobi must fail");
    let _ = std::fs::remove_file(&path);
    assert!(
        error.to_string().contains("MOBI"),
        "names the format: {error}"
    );
}
