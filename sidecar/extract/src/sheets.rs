//! XLSX / XLS / ODS → one Markdown table per sheet, through `calamine`.
//!
//! ONE READER FOR THREE FORMATS is the whole reason the pin is calamine:
//! `open_workbook_auto` sniffs the container, so the legacy binary XLS that the
//! kernel's JS path could never touch arrives here on the same code as a modern
//! XLSX. That is what let `xls` join the allowlist without a fourth extractor.
//!
//! CELL TYPES ARE PRESERVED rather than stringified through the display of
//! whatever the file happened to store: an integer stays an integer, a bool
//! reads `TRUE`, a date becomes an ISO timestamp, and an error cell says so.
//! A spreadsheet flattened to text is a spreadsheet whose numbers the wiki can
//! no longer be asked about.
//!
//! There is NO SHEET EDITOR and nothing here writes: extract is a read.

use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};

use crate::{md, ExtractError, Result};

pub fn extract(path: &Path) -> Result<String> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|error| ExtractError(format!("The workbook could not be opened: {error}")))?;
    let names = workbook.sheet_names().to_vec();
    if names.is_empty() {
        return Err(ExtractError(
            "The workbook could not be read: it has no sheets.".to_string(),
        ));
    }

    let mut out = String::new();
    for name in names {
        let range = match workbook.worksheet_range(&name) {
            Ok(range) => range,
            Err(error) => {
                // One unreadable sheet must not lose the other nine. The
                // failure is written INTO the Markdown so the owner can see
                // which sheet is missing from a Source that otherwise looks
                // complete.
                out.push_str(&format!(
                    "\n## {name}\n\n_This sheet could not be read: {error}_\n"
                ));
                continue;
            }
        };
        out.push_str(&format!("\n## {name}\n\n"));
        if range.is_empty() {
            out.push_str("_This sheet is empty._\n");
            continue;
        }
        let mut rows = range
            .rows()
            .map(|row| row.iter().map(render_cell).collect::<Vec<String>>())
            .collect::<Vec<Vec<String>>>();
        // The first row is the header: a sheet that has one means it, and a
        // sheet that does not still needs one for GFM to render the table.
        let header = rows.remove(0);
        out.push_str(&md::table(&header, &rows));
    }
    Ok(md::tidy(&out))
}

/// One cell, rendered so its TYPE is still legible in the Markdown.
pub fn render_cell(cell: &Data) -> String {
    let text = match cell {
        Data::Empty => String::new(),
        Data::String(value) => value.clone(),
        Data::Float(value) => render_float(*value),
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => if *value { "TRUE" } else { "FALSE" }.to_string(),
        Data::DateTime(value) => value
            .as_datetime()
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_else(|| render_float(value.as_f64())),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
        Data::Error(error) => format!("#ERR:{error:?}"),
    };
    md::cell(&text)
}

/// `3.0` reads as `3`, `3.5` stays `3.5`.
///
/// Excel stores every unformatted number as a float, so rendering the raw
/// `f64` would put a trailing `.0` on every count and quantity in the sheet.
fn render_float(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_floats_lose_the_decimal_tail() {
        assert_eq!(render_float(3.0), "3");
        assert_eq!(render_float(3.5), "3.5");
    }

    #[test]
    fn cell_types_are_distinguishable() {
        assert_eq!(render_cell(&Data::Int(7)), "7");
        assert_eq!(render_cell(&Data::Bool(true)), "TRUE");
        assert_eq!(render_cell(&Data::Bool(false)), "FALSE");
        assert_eq!(render_cell(&Data::Empty), "");
        assert_eq!(render_cell(&Data::String("a|b".into())), "a\\|b");
    }
}
