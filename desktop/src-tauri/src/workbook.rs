//! The Dataset wizard's workbooks, read on this computer (old ADR-0006): each
//! worksheet's cells, or why the file can't be read. Only the cells cross to
//! the page; which columns hold what is the wizard's to work out.

use std::path::Path;

use calamine::{Data, Reader, SheetType, Xlsx, open_workbook};

use crate::wire::types::{Workbook, WorkbookProblem, WorkbookSheet};

/// The largest workbook the wizard reads: a summary workbook is far smaller,
/// and one with raw traces is the user's to trim.
pub const MAX_BYTES: u64 = 50_000_000;
/// The rows of a sheet the page gets: more than a protocol's 1,000 points and
/// a few rows above them.
pub const MAX_ROWS: usize = 1_100;
/// The columns of a sheet the page gets.
pub const MAX_COLUMNS: usize = 64;

/// Reads the workbook at `path`, off the main thread.
pub async fn read_workbook(path: &Path) -> Workbook {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || read(&path))
        .await
        .unwrap_or_else(|e| {
            refused(
                String::new(),
                None,
                WorkbookProblem::Unreadable,
                e.to_string(),
            )
        })
}

/// Reads the workbook at `path`: its size and kind first, then its cells.
pub fn read(path: &Path) -> Workbook {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) => return refused(name, None, WorkbookProblem::Unreadable, e.to_string()),
    };
    if meta.is_dir() {
        return refused(name, None, WorkbookProblem::NotXlsx, "folder".into());
    }
    let bytes = Some(meta.len() as i64);
    let extension = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    if extension.as_deref() != Some("xlsx") {
        return refused(
            name,
            bytes,
            WorkbookProblem::NotXlsx,
            kind(extension.as_deref()),
        );
    }
    if meta.len() > MAX_BYTES {
        return refused(name, bytes, WorkbookProblem::TooLarge, String::new());
    }
    match sheets(path) {
        Ok(sheets) => Workbook {
            name,
            bytes,
            problem: None,
            detail: None,
            sheets,
        },
        Err(_) if encrypted(path) => refused(
            name,
            bytes,
            WorkbookProblem::Password,
            "an encrypted package in an OLE file, not a zip".into(),
        ),
        Err(e) => refused(name, bytes, WorkbookProblem::Unreadable, e.to_string()),
    }
}

/// Whether `path` is how Excel keeps a workbook protected by a password: an
/// OLE file holding an encrypted package, not a zip (MS-OFFCRYPTO).
fn encrypted(path: &Path) -> bool {
    cfb::open(path).is_ok_and(|file| file.is_stream("/EncryptedPackage"))
}

fn sheets(path: &Path) -> Result<Vec<WorkbookSheet>, calamine::XlsxError> {
    let mut book: Xlsx<_> = open_workbook(path)?;
    let names: Vec<String> = book
        .sheets_metadata()
        .iter()
        .filter(|s| s.typ == SheetType::WorkSheet)
        .map(|s| s.name.clone())
        .collect();
    names
        .into_iter()
        .map(|name| {
            let range = book.worksheet_range(&name)?;
            let (rows, columns) = range.get_size();
            let mut numbers = Vec::with_capacity(rows.min(MAX_ROWS));
            let mut texts = Vec::with_capacity(rows.min(MAX_ROWS));
            for row in range.rows().take(MAX_ROWS) {
                let row = &row[..row.len().min(MAX_COLUMNS)];
                numbers.push(row.iter().map(number).collect());
                texts.push(row.iter().map(text).collect());
            }
            Ok(WorkbookSheet {
                name,
                numbers,
                texts,
                rows: rows as i64,
                columns: columns as i64,
            })
        })
        .collect()
}

fn number(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(x) => Some(*x),
        Data::Int(n) => Some(*n as f64),
        _ => None,
    }
}

fn text(cell: &Data) -> Option<String> {
    match cell {
        Data::Empty | Data::Float(_) | Data::Int(_) => None,
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => Some(s.clone()),
        Data::Bool(b) => Some(if *b { "TRUE" } else { "FALSE" }.into()),
        Data::DateTime(d) => Some(d.to_string()),
        Data::Error(e) => Some(e.to_string()),
    }
}

/// What a file the wizard can't read is, by its extension.
fn kind(extension: Option<&str>) -> String {
    match extension {
        Some("xls") => "Excel 97–2004 workbook".into(),
        Some("xlsm") => "Excel macro-enabled workbook".into(),
        Some("xlsb") => "Excel binary workbook".into(),
        Some("ods") => "OpenDocument spreadsheet".into(),
        Some("csv") => "CSV file".into(),
        Some("") | None => "file with no extension".into(),
        Some(other) => format!(".{other} file"),
    }
}

fn refused(name: String, bytes: Option<i64>, problem: WorkbookProblem, detail: String) -> Workbook {
    Workbook {
        name,
        bytes,
        problem: Some(problem),
        detail: (!detail.is_empty()).then_some(detail),
        sheets: Vec::new(),
    }
}
