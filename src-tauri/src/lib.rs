use tauri_plugin_sql::{Migration, MigrationKind};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// window.print() is a no-op in some webviews (WebKitGTK, WKWebView), so print natively.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|error| error.to_string())
}

// Anchor downloads do nothing inside the webview, so write exports to Downloads ourselves.
#[tauri::command]
fn save_export(app: tauri::AppHandle, file_name: String, contents: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().download_dir().or_else(|_| app.path().document_dir()).map_err(|error| error.to_string())?;
    let name = std::path::Path::new(&file_name).file_name().ok_or("invalid file name")?;
    let mut path = dir.join(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let extension = path.extension().map(|value| value.to_string_lossy().into_owned());
    let mut copy = 1;
    while path.exists() {
        copy += 1;
        let numbered = match &extension {
            Some(extension) => format!("{stem} ({copy}).{extension}"),
            None => format!("{stem} ({copy})"),
        };
        path = dir.join(numbered);
    }
    std::fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create contract ledger tables",
        sql: r#"
            CREATE TABLE IF NOT EXISTS contracts (
                id TEXT PRIMARY KEY NOT NULL,
                vendor TEXT NOT NULL,
                name TEXT NOT NULL,
                reference TEXT NOT NULL,
                start_date TEXT NOT NULL,
                duration_months INTEGER NOT NULL,
                currency TEXT NOT NULL DEFAULT 'DZD',
                status TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS employees (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                account_code TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS item_assignments (
                id TEXT PRIMARY KEY NOT NULL,
                contract_id TEXT NOT NULL REFERENCES contracts(id),
                employee_id TEXT NOT NULL REFERENCES employees(id),
                item_name TEXT NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price_cents INTEGER NOT NULL,
                taken_date TEXT NOT NULL,
                reference TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS export_history (
                id TEXT PRIMARY KEY NOT NULL,
                month TEXT NOT NULL,
                kind TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                snapshot_json TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 2,
        description: "add assignment notes",
        sql: "ALTER TABLE item_assignments ADD COLUMN note TEXT NOT NULL DEFAULT '';",
        kind: MigrationKind::Up,
    }, Migration {
        version: 3,
        description: "add export subject",
        sql: "ALTER TABLE export_history ADD COLUMN subject TEXT NOT NULL DEFAULT '';",
        kind: MigrationKind::Up,
    }, Migration {
        version: 4,
        description: "multi-line orders and payment plans",
        sql: r#"
            ALTER TABLE item_assignments ADD COLUMN lines_json TEXT NOT NULL DEFAULT '';
            ALTER TABLE item_assignments ADD COLUMN total_cents INTEGER;
            ALTER TABLE item_assignments ADD COLUMN payment_months INTEGER;
            UPDATE item_assignments SET total_cents = quantity * unit_price_cents WHERE total_cents IS NULL;
        "#,
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:fundcontract.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![greet, print_window, save_export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
